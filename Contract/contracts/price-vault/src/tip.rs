//! Tip amount boundary validation for PriceVault (#1084 / CT-013).
//!
//! Zero, maximum, and overflow boundaries are checked with typed errors.
//! No wrapping arithmetic is used for tip totals or scaling.

use crate::Error;

/// Absolute maximum tip amount (aligned with [`crate::MAX_PRICE`]).
pub const MAX_TIP_AMOUNT: i128 = 1_000_000_000_000;

/// Validate a single tip amount before any transfer or storage write.
///
/// # Errors
/// * [`Error::TipAmountZero`] — `amount == 0`
/// * [`Error::NonPositiveAmount`] — `amount < 0`
/// * [`Error::TipAmountTooLarge`] — `amount > MAX_TIP_AMOUNT`
pub fn validate_tip_amount(amount: i128) -> Result<i128, Error> {
    if amount == 0 {
        return Err(Error::TipAmountZero);
    }
    if amount < 0 {
        return Err(Error::NonPositiveAmount);
    }
    if amount > MAX_TIP_AMOUNT {
        return Err(Error::TipAmountTooLarge);
    }
    Ok(amount)
}

/// Checked sum of tip amounts (batch tips).
pub fn sum_tip_amounts(amounts: &[i128]) -> Result<i128, Error> {
    let mut total: i128 = 0;
    for &a in amounts {
        let a = validate_tip_amount(a)?;
        total = total.checked_add(a).ok_or(Error::ArithmeticOverflow)?;
    }
    if total > MAX_TIP_AMOUNT {
        return Err(Error::TipAmountTooLarge);
    }
    Ok(total)
}

/// Scale a tip by a positive multiplier using checked arithmetic.
pub fn scale_tip_amount(amount: i128, multiplier: i128) -> Result<i128, Error> {
    let amount = validate_tip_amount(amount)?;
    if multiplier < 0 {
        return Err(Error::NonPositiveAmount);
    }
    if multiplier == 0 {
        return Err(Error::TipAmountZero);
    }
    let product = amount
        .checked_mul(multiplier)
        .ok_or(Error::ArithmeticOverflowMul)?;
    validate_tip_amount(product)
}
