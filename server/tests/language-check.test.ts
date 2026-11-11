import { describe, expect, it } from 'vitest';
import { scriptShare } from '../src/scripts/languageCheck.js';

describe('language check script measure', () => {
  it('counts letters in the target script, other Indic scripts and the rest', () => {
    expect(scriptShare('உங்களைப் பற்றி சொல்லுங்கள்', 'ta')).toMatchObject({ target: 1, otherIndic: 0 });
    const mixed = scriptShare('మీ టీమ్ లో conflict', 'te'); // eight Telugu letters and signs, eight Latin letters
    expect(mixed).toEqual({ letters: 16, target: 0.5, otherIndic: 0 });
    expect(scriptShare('আপনার সম্পর্কে বলুন', 'bn').target).toBe(1);
    expect(scriptShare('तुमच्या बद्दल सांगा', 'mr').target).toBe(1);
    // Hindi written for a Tamil interview is the wrong script.
    expect(scriptShare('अपने बारे में बताइए', 'ta')).toMatchObject({ target: 0, otherIndic: expect.any(Number) });
    expect(scriptShare('123 !?', 'ta')).toEqual({ letters: 0, target: 0, otherIndic: 0 });
  });
});
