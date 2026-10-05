(function () {
  'use strict';

  function mergeTranscript(previous, next) {
    const left = String(previous || '').trim();
    const right = String(next || '').trim();
    if (!left) return right;
    if (!right || left.endsWith(right)) return left;
    if (right.startsWith(left)) return right;
    const maxOverlap = Math.min(left.length, right.length);
    for (let size = maxOverlap; size >= 2; size--) {
      if (left.slice(-size) === right.slice(0, size)) return left + right.slice(size);
    }
    const joiner = /[\u3400-\u9fff]$/.test(left) && /^[\u3400-\u9fff]/.test(right) ? '' : ' ';
    return left + joiner + right;
  }

  function createTranscriptAssembler() {
    let confirmed = '';
    let carry = '';
    let interim = '';
    return {
      begin(text) { confirmed = String(text || '').trim(); carry = ''; interim = ''; },
      final(text) {
        confirmed = mergeTranscript(confirmed, mergeTranscript(carry, text));
        carry = '';
        interim = '';
        return confirmed;
      },
      provisional(text) { interim = String(text || '').trim(); return this.text(); },
      segmentEnd() { carry = mergeTranscript(carry, interim); interim = ''; return this.text(); },
      text() { return mergeTranscript(confirmed, mergeTranscript(carry, interim)); },
      finish() { confirmed = this.text(); carry = ''; interim = ''; return confirmed; },
    };
  }

  window.AssistantTranscript = { createTranscriptAssembler, mergeTranscript };
})();
