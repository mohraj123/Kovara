import {
  parseAmountToUnits,
  DEFAULT_TOKEN_DECIMALS,
  usePoolDeposit,
} from '../hooks/usePoolDeposit';

describe('parseAmountToUnits', () => {
  it('accepts whole numbers within decimal bounds', () => {
    expect(parseAmountToUnits('1', 7)).toEqual({ ok: true, units: '10000000' });
    expect(parseAmountToUnits('10', 2)).toEqual({ ok: true, units: '1000' });
  });

  it('accepts fractional amounts at exact decimal precision', () => {
    expect(parseAmountToUnits('1.5', 7)).toEqual({ ok: true, units: '15000000' });
    expect(parseAmountToUnits('0.0000001', 7)).toEqual({ ok: true, units: '1' });
    expect(parseAmountToUnits('1.23', 2)).toEqual({ ok: true, units: '123' });
  });

  it('rejects excess fractional digits', () => {
    const result = parseAmountToUnits('1.12345678', 7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/too many decimal places/i);
    }
  });

  it('rejects zero and negative-looking values', () => {
    expect(parseAmountToUnits('0', 7).ok).toBe(false);
    expect(parseAmountToUnits('0.0', 7).ok).toBe(false);
    expect(parseAmountToUnits('0.0000000', 7).ok).toBe(false);
    expect(parseAmountToUnits('-1', 7).ok).toBe(false);
  });

  it('rejects empty, scientific notation, and non-numeric input', () => {
    expect(parseAmountToUnits('', 7).ok).toBe(false);
    expect(parseAmountToUnits('   ', 7).ok).toBe(false);
    expect(parseAmountToUnits('1e7', 7).ok).toBe(false);
    expect(parseAmountToUnits('abc', 7).ok).toBe(false);
    expect(parseAmountToUnits('1.2.3', 7).ok).toBe(false);
  });

  it('rejects invalid decimals configuration', () => {
    expect(parseAmountToUnits('1', -1).ok).toBe(false);
    expect(parseAmountToUnits('1', 1.5).ok).toBe(false);
    expect(parseAmountToUnits('1', 19).ok).toBe(false);
  });

  it('uses DEFAULT_TOKEN_DECIMALS of 7', () => {
    expect(DEFAULT_TOKEN_DECIMALS).toBe(7);
    expect(parseAmountToUnits('1', DEFAULT_TOKEN_DECIMALS)).toEqual({
      ok: true,
      units: '10000000',
    });
  });

  it('handles leading zeros and plus sign', () => {
    expect(parseAmountToUnits('+1.5', 2)).toEqual({ ok: true, units: '150' });
    expect(parseAmountToUnits('01.50', 2)).toEqual({ ok: true, units: '150' });
  });
});

describe('usePoolDeposit', () => {
  it('preserves the entered amount and exposes a retryable error on failure', async () => {
    const submit = jest.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() =>
      usePoolDeposit({ submit, decimals: DEFAULT_TOKEN_DECIMALS }),
    );

    act(() => {
      result.current.setAmount('1.5');
    });

    await act(async () => {
      await result.current.deposit();
    });

    expect(result.current.amount).toBe('1.5');
    expect(result.current.error).toBeTruthy();
    expect(result.current.canRetry).toBe(true);
  });
});
           
