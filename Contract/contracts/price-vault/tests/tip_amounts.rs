//! #1084 CT-013 — tip amount boundary coverage.
#![cfg(test)]

use kovara_price_vault::tip::{scale_tip_amount, sum_tip_amounts, validate_tip_amount, MAX_TIP_AMOUNT};
use kovara_price_vault::Error;

#[test]
fn zero_and_negative() {
    assert_eq!(validate_tip_amount(0), Err(Error::TipAmountZero));
    assert_eq!(validate_tip_amount(-1), Err(Error::NonPositiveAmount));
}

#[test]
fn max_and_above() {
    assert_eq!(validate_tip_amount(MAX_TIP_AMOUNT), Ok(MAX_TIP_AMOUNT));
    assert_eq!(
        validate_tip_amount(MAX_TIP_AMOUNT + 1),
        Err(Error::TipAmountTooLarge)
    );
}

#[test]
fn sum_and_scale_boundaries() {
    assert_eq!(sum_tip_amounts(&[1, 2, 3]), Ok(6));
    assert_eq!(sum_tip_amounts(&[MAX_TIP_AMOUNT, 1]), Err(Error::TipAmountTooLarge));
    assert_eq!(scale_tip_amount(10, 3), Ok(30));
    let err = scale_tip_amount(MAX_TIP_AMOUNT, 2).unwrap_err();
    assert!(matches!(
        err,
        Error::ArithmeticOverflowMul | Error::TipAmountTooLarge
    ));
}
