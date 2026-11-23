import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { usePoolDeposit, parseAmountToUnits, DEFAULT_TOKEN_DECIMALS } from '../hooks/usePoolDeposit';

interface PoolDepositFormProps {
  poolId: string;
  token: string;
  /** Optional decimals from pool token metadata; defaults to Stellar 7. */
  tokenDecimals?: number;
  onSuccess?: () => void;
}

export function PoolDepositForm({
  poolId,
  token,
  tokenDecimals,
  onSuccess,
}: PoolDepositFormProps) {
  const [amount, setAmount] = useState('');
  const { pending, success, error, txHash, deposit, reset } = usePoolDeposit();

  const decimals =
    tokenDecimals != null && Number.isInteger(tokenDecimals)
      ? tokenDecimals
      : DEFAULT_TOKEN_DECIMALS;
  // MO-006: notify parent (e.g. pool detail) so it can refresh query data
  // after a confirmed deposit and avoid stale balances.
  useEffect(() => {
    if (success && onSuccess) {
      onSuccess();
    }
  }, [success, onSuccess]);

  const handleDeposit = useCallback(async () => {
    if (pending) return;
    
    if (!poolId?.trim()) {
      Alert.alert('Validation Error', 'Pool ID is required');
      return;
    }
    if (!token?.trim()) {
      Alert.alert('Validation Error', 'Token is required');
      return;
    }
    if (!amount.trim()) {
      Alert.alert('Validation Error', 'Please enter an amount');
      return;
    }

    const parsed = parseAmountToUnits(amount, decimals);
    if (!parsed.ok) {
      Alert.alert('Validation Error', parsed.error);
      return;
    }

    try {
      await deposit(poolId, amount, token);
    } catch (err) {
      // FE-19: the entered amount is kept in state so the user can retry.
      // The hook surfaces the error via `setError`; avoid duplicating it in an alert.
      // Only fall back to an alert if the hook did not record an error.
      const message = err instanceof Error ? err.message : 'Deposit failed';
      Alert.alert('Error', message);
    }
  }, [amount, deposit, poolId, token, decimals, pending]);

  const handleReset = useCallback(() => {
    reset();
    setAmount('');
  }, [reset]);

  if (success) {
    return (
      <View style={styles.container}>
        <View style={styles.successContainer}>
          <Text style={styles.successTitle}>Deposit Successful!</Text>
          <Text style={styles.successMessage}>
            You have successfully deposited {amount} {token} to the pool.
          </Text>
          {txHash && (
            <Text style={styles.txHash}>
              Transaction: {txHash.slice(0, 10)}...{txHash.slice(-8)}
            </Text>
          )}
          <TouchableOpacity
            style={styles.button}
            onPress={handleReset}
            accessibilityRole="button"
            accessibilityLabel="Deposit another amount"
          >
            <Text style={styles.buttonText}>Deposit More</Text>
          </TouchableOpacity>
          {onSuccess && (
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={onSuccess}
              accessibilityRole="button"
              accessibilityLabel="Close deposit form"
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>Done</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Deposit Amount</Text>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          placeholderTextColor="#64748b"
          keyboardType="decimal-pad"
          editable={!pending}
          testID="deposit-amount-input"
          accessibilityLabel="Deposit amount"
        />
        <Text style={styles.tokenLabel}>{token}</Text>
      </View>
      <Text style={styles.note}>
        Max {decimals} decimal places. Pool and token are verified before signing.
      </Text>

      {error ? (
        <View style={styles.errorContainer} testID="deposit-error">
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.retryHint}>
            Your amount has been kept. Tap Deposit to retry.
          </Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.button, pending && styles.buttonDisabled]}
        onPress={handleDeposit}
        disabled={pending}
        accessibilityRole="button"
        accessibilityLabel={pending ? 'Processing deposit' : error ? 'Retry deposit' : 'Confirm deposit'}
        testID="deposit-button"
      >
        {pending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{error ? 'Retry Deposit' : 'Deposit'}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    marginVertical: 8,
    marginHorizontal: 16,
  },
  label: {
    color: '#cbd3e1',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  input: {
    flex: 1,
    color: '#f1f5f9',
    fontSize: 16,
    paddingVertical: 12,
    paddingRight: 8,
  },
  tokenLabel: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
  note: {
    color: '#64748b',
    fontSize: 12,
    marginBottom: 12,
    fontStyle: 'italic',
  },
  button: {
    backgroundColor: '#6366f1',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#64748b',
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#6366f1',
    marginTop: 8,
  },
  secondaryButtonText: {
    color: '#6366f1',
  },
  successContainer: {
    alignItems: 'center',
  },
  successTitle: {
    color: '#22c55e',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  successMessage: {
    color: '#cbd5e1',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
  },
  txHash: {
    color: '#64748b',
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 16,
  },
  errorContainer: {
    backgroundColor: '#7f1d1d',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#dc2626',
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 12,
  },
  retryHint: {
    color: '#fecaca',
    fontSize: 11,
    marginTop: 4,
    italic: true,
  },
});
