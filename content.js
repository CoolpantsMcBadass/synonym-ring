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

  // ── Datamuse API ───────────────────────────────────────────────────────────

  async function fetchSynonyms(word) {
    const bare = word.toLowerCase().replace(/[^a-z'-]/g, '');
    if (!bare) return [];
    try {
      const res = await fetch(
        `https://api.datamuse.com/words?rel_syn=${encodeURIComponent(bare)}&max=30`
      );
      if (!res.ok) return [];
      const data = await res.json();
      if (!data.length) return [];

      const isMultiWord = bare.includes(' ');
      const topScore = data[0].score || 1;
      const threshold = topScore * 0.2;

      return data
        .filter(d => d.score >= threshold)
        .filter(d => isMultiWord || !d.word.includes(' '))  // match single/multi word style
        .map(d => d.word)
        .slice(0, 20);
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
    return { start, end, word: text.slice(start, end) };
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

    return { node: startNode, start: range.startOffset, end: range.startOffset + word.length, word };
  }

  // ── DOM replacement ────────────────────────────────────────────────────────

  function replaceInTextarea(newWord) {
    const el = ring.element;
    const start = ring.wordStart;
    const text = el.value;
    el.value = text.slice(0, start) + newWord + text.slice(start + ring._currentLen);
    el.selectionStart = start;
    el.selectionEnd = start + newWord.length;
    ring._currentLen = newWord.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function replaceInContentEditable(newWord) {
    ring.element.focus();
    const sel = window.getSelection();
    if (!sel) return;

    // Works for both first call (cursor somewhere in word from long-press)
    // and subsequent calls (cursor at end of last inserted word from execCommand).
    // In both cases: jump to word start, extend to word end, then trim any
    // trailing non-word chars Chrome includes — all via sel.modify so the
    // browser uses the same word boundaries as execCommand, avoiding off-by-one.
    sel.modify('move', 'backward', 'word');
    sel.modify('extend', 'forward', 'word');

    const raw = sel.toString();
    const match = raw.match(/^[\w'-]+/);
    if (!match) return;

    // Trim trailing non-word chars using the same movement API (no range arithmetic)
    const extra = raw.length - match[0].length;
    for (let i = 0; i < extra; i++) {
      sel.modify('extend', 'backward', 'character');
    }

    if (!sel.toString()) return;
    document.execCommand('insertText', false, newWord);
    ring.element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: newWord }));
    ring._currentLen = newWord.length;
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
    const synonyms = await fetchSynonyms(bounds.word);
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
      exitRing(false);
    } else {
      // Block everything else while ring is active
      blockEvent(e);
    }
  }, true);

})();
