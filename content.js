(function () {
  'use strict';


  // ── State ──────────────────────────────────────────────────────────────────

  let ring = null;
  /*
    ring = {
      isTextarea : bool,
      element    : HTMLElement,
      original   : string,       // word as it appeared in DOM (original casing)
      words      : string[],     // [original, syn1, syn2, ...]
      index      : number,       // current position in words[]
      _currentLen: number,       // byte-length of word currently in DOM

      // textarea / input
      wordStart  : number,       // fixed char index in element.value

      // contenteditable
      textNode   : Text,         // text node containing the word
      nodeStart  : number,       // fixed char index in textNode.textContent

      anchorX    : number,
      anchorY    : number,
    }
  */

  let pendingFetch = null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function isEditableTextarea(el) {
    return el && (
      el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file')
    );
  }

  function isContentEditable(el) {
    return el && el.isContentEditable;
  }

  function matchCase(original, word) {
    if (!word) return word;
    if (original === original.toUpperCase() && original.length > 1) return word.toUpperCase();
    if (original[0] === original[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
    return word;
  }

  function currentWord() {
    if (!ring) return '';
    return matchCase(ring.original, ring.words[ring.index]);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function adjacentWords(text, start, end) {
    const leftMatch  = text.slice(0, start).match(/(\w+)\W*$/);
    const rightMatch = text.slice(end).match(/^\W*(\w+)/);
    return {
      left:  leftMatch  ? leftMatch[1]  : null,
      right: rightMatch ? rightMatch[1] : null,
    };
  }

  // ── Inflection matching ────────────────────────────────────────────────────
  // Datamuse returns base/lemma forms. If the original word is an inflected
  // form (-s, -es, -ed, -ing), re-inflect synonyms to match.

  function inflect(synonym, original) {
    const orig = original.toLowerCase();
    const syn  = synonym.toLowerCase();
    if (syn.endsWith('ing') || syn.endsWith('ed')) return synonym; // already inflected

    // -ing  (matching, running)
    if (orig.endsWith('ing')) {
      if (syn.endsWith('e')) return syn.slice(0, -1) + 'ing'; // make → making
      return syn + 'ing';
    }
    // -ed  (matched, walked)
    if (orig.endsWith('ed')) {
      if (syn.endsWith('e')) return syn + 'd';   // love → loved
      return syn + 'ed';
    }
    // -es  (matches, catches) — must check before -s
    if (orig.endsWith('es') && !syn.endsWith('s')) {
      return /(?:ch|sh|[xzs])$/.test(syn) ? syn + 'es' : syn + 's';
    }
    // -s  (runs, plays)
    if (orig.endsWith('s') && !orig.endsWith('ss') && !syn.endsWith('s')) {
      return /(?:ch|sh|[xzs])$/.test(syn) ? syn + 'es' : syn + 's';
    }
    return synonym;
  }

  // ── Datamuse API ───────────────────────────────────────────────────────────

  async function fetchSynonyms(word, { left, right } = {}) {
    const bare = word.toLowerCase().replace(/[^a-z'-]/g, '');
    if (!bare) return [];
    const enc = encodeURIComponent(bare);
    const ctx = [
      left  ? `&lc=${encodeURIComponent(left.toLowerCase())}`  : '',
      right ? `&rc=${encodeURIComponent(right.toLowerCase())}` : '',
    ].join('');
    const CORE_POS = ['n', 'v', 'adj', 'adv'];
    try {
      const [synRes, mlRes, posRes] = await Promise.all([
        fetch(`https://api.datamuse.com/words?rel_syn=${enc}${ctx}&max=30&md=p`),
        fetch(`https://api.datamuse.com/words?ml=${enc}${ctx}&max=30&md=p`),
        fetch(`https://api.datamuse.com/words?sp=${enc}&md=p&max=1`),
      ]);

      const parse = async (res) => res.ok ? res.json() : [];
      const [synData, mlData, posData] = await Promise.all([parse(synRes), parse(mlRes), parse(posRes)]);

      // POS tags for the original word (n / v / adj / adv)
      const originalPos = (posData[0]?.tags ?? []).filter(t => CORE_POS.includes(t));

      // Narrow POS using grammatical context clues so ambiguous words like
      // "test" (n or v) resolve correctly — e.g. "to test" must be a verb.
      const DET = new Set(['a','an','the','my','your','his','her','its','our','their','this','that','these','those']);
      const l = left?.toLowerCase();
      let effectivePos = originalPos;
      if (originalPos.length > 1) {
        if (l === 'to' && originalPos.includes('v'))        effectivePos = ['v'];
        else if (DET.has(l) && originalPos.includes('n'))   effectivePos = ['n', 'adj'];
      }

      // Merge: for duplicates keep the higher score
      const seen = new Map();
      for (const d of [...synData, ...mlData]) {
        const existing = seen.get(d.word);
        if (!existing || d.score > existing.score) seen.set(d.word, d);
      }

      if (!seen.size) return [];

      const isMultiWord = bare.includes(' ');
      const allResults = [...seen.values()].sort((a, b) => b.score - a.score);
      const topScore = allResults[0].score || 1;
      const threshold = topScore * 0.15;

      return allResults
        .filter(d => d.score >= threshold)
        .filter(d => isMultiWord || !d.word.includes(' '))
        .filter(d => {
          if (!effectivePos.length) return true; // unknown POS — don't filter
          const resultPos = (d.tags ?? []).filter(t => CORE_POS.includes(t));
          if (!resultPos.length) return true;    // result has no POS tag — keep
          return resultPos.some(t => effectivePos.includes(t));
        })
        .map(d => inflect(d.word, bare))
        .filter(w => w !== bare)
        .slice(0, 25);
    } catch (err) {
      console.warn('[SynonymRing] fetch failed:', err);
      return [];
    }
  }

  // ── Word boundary detection ────────────────────────────────────────────────

  function wordBoundsInTextarea(el) {
    const text = el.value;
    const pos = el.selectionStart;
    let start = pos, end = pos;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;
    if (start === end) return null;
    return { start, end, word: text.slice(start, end), ...adjacentWords(text, start, end) };
  }

  function wordBoundsAtPoint(x, y) {
    // Place caret at click point
    let initRange;
    if (document.caretRangeFromPoint) {
      initRange = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { initRange = document.createRange(); initRange.setStart(p.offsetNode, p.offset); initRange.collapse(true); }
    }
    if (!initRange) return null;

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(initRange);

    // sel.modify works across text nodes / inline spans — avoids the split-node
    // problem where a manual walk stops at a node boundary mid-word
    sel.modify('move', 'backward', 'word'); // cursor → word start
    sel.modify('extend', 'forward', 'word'); // extend → word end (Chrome includes trailing space)

    // Chrome's 'forward word' overshoots to include trailing whitespace; trim
    const raw = sel.toString();
    const word = raw.match(/^[\w'-]+/)?.[0];
    if (!word || word.length < 2) { sel.removeAllRanges(); return null; }

    // Anchor for first replacement comes from selection start
    const range = sel.getRangeAt(0);
    const startNode = range.startContainer;
    if (!startNode || startNode.nodeType !== Node.TEXT_NODE) return null;

    // Shrink selection to just the word (drop trailing whitespace Chrome added)
    if (sel.toString() !== word) {
      const trimmed = document.createRange();
      trimmed.setStart(startNode, range.startOffset);
      trimmed.setEnd(startNode, range.startOffset + word.length);
      sel.removeAllRanges();
      sel.addRange(trimmed);
    }

    const nodeText = startNode.textContent;
    const wordStart = range.startOffset;
    return { node: startNode, start: wordStart, end: wordStart + word.length, word,
             ...adjacentWords(nodeText, wordStart, wordStart + word.length) };
  }

  // ── DOM replacement ────────────────────────────────────────────────────────

  function replaceInTextarea(newWord) {
    const el = ring.element;
    const start = ring.wordStart;
    const text = el.value;
    const newValue = text.slice(0, start) + newWord + text.slice(start + ring._currentLen);

    // Use the native value setter so React-controlled inputs pick up the change.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, newValue);
    } else {
      el.value = newValue;
    }

    el.selectionStart = start;
    el.selectionEnd = start + newWord.length;
    ring._currentLen = newWord.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function replaceInContentEditable(newWord) {
    // Focus the contenteditable root, not an arbitrary child element (e.target
    // during long-press can be a nested <span>, <b>, etc.).
    const editableRoot = ring.element.closest('[contenteditable="true"]') ?? ring.element;
    editableRoot.focus();

    const sel = window.getSelection();
    if (!sel) return;

    if (!ring.textNode?.isConnected) {
      console.warn('[SynonymRing] textNode is stale — cannot replace');
      return;
    }

    try {
      const range = document.createRange();
      range.setStart(ring.textNode, ring.nodeStart);
      range.setEnd(ring.textNode, ring.nodeStart + ring._currentLen);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      console.warn('[SynonymRing] range creation failed:', e);
      return;
    }

    const cmdOk = document.execCommand('insertText', false, newWord);

    // execCommand often splits text nodes. Re-anchor from the updated cursor
    // position so future replacements use the correct node/offset.
    if (sel.rangeCount > 0) {
      const cur = sel.getRangeAt(0);
      if (cur.startContainer.nodeType === Node.TEXT_NODE) {
        ring.textNode = cur.startContainer;
        ring.nodeStart = cur.startOffset - newWord.length;
      }
    }

    if (!cmdOk && ring.textNode?.isConnected) {
      // execCommand failed — try direct write. This won't work in React-based
      // editors but is a best-effort fallback for simpler contenteditable fields.
      ring.textNode.textContent =
        ring.textNode.textContent.slice(0, ring.nodeStart) + newWord +
        ring.textNode.textContent.slice(ring.nodeStart + ring._currentLen);
    }

    ring._currentLen = newWord.length;

    try {
      const cur = document.createRange();
      cur.setStart(ring.textNode, ring.nodeStart + newWord.length);
      cur.collapse(true);
      sel.removeAllRanges();
      sel.addRange(cur);
    } catch (_) {}

    editableRoot.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: newWord }));
  }

  // ── Widget ─────────────────────────────────────────────────────────────────

  function getWordRect() {
    if (!ring.isTextarea && ring.textNode) {
      try {
        const r = document.createRange();
        r.setStart(ring.textNode, ring.nodeStart);
        r.setEnd(ring.textNode, ring.nodeStart + ring._currentLen);
        const rect = r.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) return rect;
      } catch (_) {}
    }
    // Fallback: treat anchor point as a zero-size rect
    return { left: ring.anchorX, right: ring.anchorX, top: ring.anchorY, bottom: ring.anchorY, width: 0, height: 20 };
  }

  function showWidget(direction) {
    let widget = document.getElementById('synonym-ring-widget');
    if (!widget) {
      widget = document.createElement('div');
      widget.id = 'synonym-ring-widget';
      document.body.appendChild(widget);
    }

    const total = ring.words.length;
    const prevIdx = (ring.index - 1 + total) % total;
    const nextIdx = (ring.index + 1) % total;
    const prevWord = matchCase(ring.original, ring.words[prevIdx]);
    const nextWord = matchCase(ring.original, ring.words[nextIdx]);

    const slideClass = direction ? `sr-slide-${direction}` : '';
    widget.innerHTML = `
      <div class="sr-original">${escapeHtml(ring.original)}</div>
      <div class="sr-adj sr-adj-up">
        <span class="sr-chevron">▲</span>
        <span class="sr-neighbor">${escapeHtml(prevWord)}</span>
      </div>
      <div class="sr-current">
        <span class="sr-word ${slideClass}">${escapeHtml(currentWord())}</span>
        <span class="sr-pos">${ring.index}/${total - 1}</span>
      </div>
      <div class="sr-adj sr-adj-down">
        <span class="sr-chevron">▼</span>
        <span class="sr-neighbor">${escapeHtml(nextWord)}</span>
      </div>`;

    // Widget row actions are handled by the window-level mousedown interceptor below

    // Position only on first render; subsequent calls just refresh content
    if (ring._widgetPositioned) {
      widget.style.visibility = 'visible';
      return;
    }

    widget.style.visibility = 'hidden';
    widget.style.left = '0px';
    widget.style.top = '0px';

    requestAnimationFrame(() => {
      const rect = getWordRect();
      const ww = widget.offsetWidth;
      const wh = widget.offsetHeight;
      const rowH = wh / 3;

      const wordCenterX = rect.left + rect.width / 2;
      let left = wordCenterX - ww / 2;
      left = Math.max(4, Math.min(left, window.innerWidth - ww - 4));

      const wordCenterY = rect.top + rect.height / 2;
      let top = wordCenterY - rowH * 1.5;
      top = Math.max(4, Math.min(top, window.innerHeight - wh - 4));

      widget.style.left = `${left}px`;
      widget.style.top  = `${top}px`;
      widget.style.visibility = 'visible';
      ring._widgetPositioned = true;
    });
  }

  function hideWidget() {
    const el = document.getElementById('synonym-ring-widget');
    if (el) el.remove();
  }

  function showStatus(msg) {
    let el = document.getElementById('synonym-ring-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'synonym-ring-status';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.left = `${pressX}px`;
    el.style.top  = `${Math.max(pressY - 36, 4)}px`;
    setTimeout(() => { if (el.textContent === msg) el.remove(); }, 2000);
  }

  // ── Ring lifecycle ─────────────────────────────────────────────────────────

  function applyWord(direction) {
    const word = currentWord();
    if (ring.isTextarea) replaceInTextarea(word);
    else replaceInContentEditable(word);
    showWidget(direction);
  }

  function placeCursorAtEnd(snapshot) {
    if (!snapshot.isTextarea) return; // contenteditable: cursor is already at word end from execCommand
    setTimeout(() => {
      snapshot.element.focus();
      const pos = snapshot.wordStart + snapshot.finalLen;
      snapshot.element.selectionStart = pos;
      snapshot.element.selectionEnd = pos;
    }, 0);
  }

  function exitRing(revert) {
    if (!ring) return;
    if (revert) {
      ring.index = 0;
      applyWord();
    } else {
      // Snapshot what we need before ring is nulled
      const snapshot = {
        isTextarea: ring.isTextarea,
        element:    ring.element,
        textNode:   ring.textNode,
        nodeStart:  ring.nodeStart,
        wordStart:  ring.wordStart,
        finalLen:   ring._currentLen,
      };
      placeCursorAtEnd(snapshot);
    }
    hideWidget();
    ring = null;
  }

  async function activateRing(target, isTA, x, y) {
    let bounds;
    if (isTA) {
      bounds = wordBoundsInTextarea(target);
    } else {
      bounds = wordBoundsAtPoint(x, y);
    }

    if (!bounds || bounds.word.length < 2) {
      showStatus('no word found');
      return;
    }

    showStatus(`"${bounds.word}" …`);

    const token = {};
    pendingFetch = token;
    const synonyms = await fetchSynonyms(bounds.word, { left: bounds.left, right: bounds.right });
    if (pendingFetch !== token) return;
    pendingFetch = null;

    if (!synonyms.length) {
      showStatus(`no synonyms for "${bounds.word}"`);
      return;
    }

    ring = {
      isTextarea: isTA,
      element: target,
      original: bounds.word,
      words: [bounds.word, ...synonyms],
      index: 0,
      _currentLen: bounds.word.length,
      anchorX: x,
      anchorY: y,
      ...(isTA
        ? { wordStart: bounds.start }
        : { textNode: bounds.node, nodeStart: bounds.start }),
    };

    showWidget();
  }

  // ── Long-press detection ───────────────────────────────────────────────────

  const LONG_PRESS_MS = 500;
  const MOVE_CANCEL_PX = 12;

  let pressTimer = null;
  let pressTarget = null;
  let pressIsTA = false;
  let pressX = 0, pressY = 0;

  function cancelPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    hidePulse();
    pressTarget = null;
  }

  function showPulse(x, y) {
    let el = document.getElementById('synonym-ring-pulse');
    if (!el) {
      el = document.createElement('div');
      el.id = 'synonym-ring-pulse';
      document.body.appendChild(el);
    }
    el.style.left = `${x - 18}px`;
    el.style.top  = `${y - 18}px`;
  }

  function hidePulse() {
    const el = document.getElementById('synonym-ring-pulse');
    if (el) el.remove();
  }

  let swallowNextMouseup = false;
  let ignoreSyntheticMouseup = false;

  window.addEventListener('mousedown', (e) => {
    if (ring) {
      const inWidget = !!e.target.closest('#synonym-ring-widget');

      if (inWidget) {
        // Block ALL listeners (including Word Online's doc-level handlers) from seeing this
        e.preventDefault();
        e.stopImmediatePropagation();
        swallowNextMouseup = true;

        if (e.target.closest('.sr-adj-up')) {
          ring.index = (ring.index - 1 + ring.words.length) % ring.words.length;
          applyWord('up');
          exitRing(false);
        } else if (e.target.closest('.sr-adj-down')) {
          ring.index = (ring.index + 1) % ring.words.length;
          applyWord('down');
          exitRing(false);
        }
        return;
      }

      // Click outside widget — dismiss
      blockEvent(e);
      exitRing(false);
      return;
    }

    const target = e.target;
    const isTA = isEditableTextarea(target);
    const isCE = !isTA && isContentEditable(target);
    if (!isTA && !isCE) return;

    pressTarget = target;
    pressIsTA   = isTA;
    pressX = e.clientX;
    pressY = e.clientY;

    showPulse(e.clientX, e.clientY);

    pressTimer = setTimeout(() => {
      pressTimer = null;
      hidePulse();

      // The editor entered drag mode on the original mousedown. Send a synthetic
      // mouseup to cleanly end that drag state before the ring takes over.
      // ignoreSyntheticMouseup lets our window handler pass it through to the editor.
      ignoreSyntheticMouseup = true;
      pressTarget.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: false,
        clientX: pressX, clientY: pressY, view: window,
      }));
      ignoreSyntheticMouseup = false;

      // Swallow the real mouseup when the user eventually releases
      swallowNextMouseup = true;

      activateRing(pressTarget, pressIsTA, pressX, pressY);
      pressTarget = null;
    }, LONG_PRESS_MS);
  }, true);

  window.addEventListener('mouseup', (e) => {
    if (ignoreSyntheticMouseup) return; // let synthetic mouseup reach the editor
    if (swallowNextMouseup) {
      e.preventDefault();
      e.stopImmediatePropagation();
      swallowNextMouseup = false;
      return;
    }
    cancelPress();
  }, true);

  window.addEventListener('mousemove', (e) => {
    if (!pressTimer) return;
    const dx = e.clientX - pressX;
    const dy = e.clientY - pressY;
    if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) cancelPress();
  }, true);

  // ── Keydown: cycle / confirm / revert ─────────────────────────────────────

  function blockEvent(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  window.addEventListener('keydown', (e) => {
    if (!ring) return;

    if (e.key === 'ArrowDown') {
      blockEvent(e);
      ring.index = (ring.index + 1) % ring.words.length;
      applyWord('down');
    } else if (e.key === 'ArrowUp') {
      blockEvent(e);
      ring.index = (ring.index - 1 + ring.words.length) % ring.words.length;
      applyWord('up');
    } else if (e.key === 'Escape') {
      blockEvent(e);
      exitRing(true);
    } else if (e.key === 'Enter') {
      blockEvent(e);
      applyWord();
      exitRing(false);
    } else {
      // Block everything else while ring is active
      blockEvent(e);
    }
  }, true);

})();
