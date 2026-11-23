import { sanitizeBannerUrl } from '../../utils/sanitizeUrl';
import { validateBannerUrl, validatePostContent, validateUsername } from '../validate';

/**
 * `validateBannerUrl` delegates to `sanitizeBannerUrl` (FE-28), so these two
 * describe one rule from both sides: what the form accepts, and what the
 * renderer will actually display.
 */
describe('validateBannerUrl', () => {
  it('accepts an empty value, because the banner is optional', () => {
    expect(validateBannerUrl('')).toEqual({ valid: true });
    expect(validateBannerUrl('   ')).toEqual({ valid: true });
  });

  it('accepts http and https URLs', () => {
    expect(validateBannerUrl('https://cdn.example.com/banner.png')).toEqual({ valid: true });
    expect(validateBannerUrl('http://cdn.example.com/banner.png')).toEqual({ valid: true });
  });

  it('rejects unsafe schemes with a field error', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      const result = validateBannerUrl(value);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    }
  });

  it('rejects a value that is not a URL at all', () => {
    expect(validateBannerUrl('not a url').valid).toBe(false);
  });

  it('rejects an oversized URL, matching what the renderer enforces', () => {
    // The form used to accept a 3000-character URL that the renderer then
    // dropped, so the banner silently disappeared after saving.
    const long = `https://cdn.example.com/${'a'.repeat(3000)}.png`;
    expect(validateBannerUrl(long).valid).toBe(false);
    expect(sanitizeBannerUrl(long)).toBe('');
  });

  it('agrees with the renderer on every input', () => {
    // One rule, two entry points: anything the form accepts must survive
    // sanitisation, and anything it rejects must not render.
    const candidates = [
      'https://cdn.example.com/banner.png',
      'http://cdn.example.com/banner.png',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'not a url',
      'https://cdn.example.com/' + 'a'.repeat(3000) + '.png',
    ];

    for (const value of candidates) {
      const accepted = validateBannerUrl(value).valid;
      const rendered = sanitizeBannerUrl(value) !== '';
      expect(accepted).toBe(rendered);
    }
  });
});

describe('validate.ts — existing rules still behave', () => {
  it('validates usernames', () => {
    expect(validateUsername('maya').valid).toBe(true);
    expect(validateUsername('ab').valid).toBe(false);
    expect(validateUsername('has space').valid).toBe(false);
  });

  it('validates post content', () => {
    expect(validatePostContent('hello').valid).toBe(true);
    expect(validatePostContent('   ').valid).toBe(false);
  });
});
