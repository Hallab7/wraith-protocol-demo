import { describe, expect, it } from 'vitest';
import { deriveVaultState, getVaultActions, type OnChainVaultDeposit } from './vaultStatus';

const SENDER = 'GSENDER';
const RECIPIENT = 'GRECIPIENT';

function deposit(state: OnChainVaultDeposit['state']): OnChainVaultDeposit {
  return {
    id: 'ab'.repeat(32),
    sender: SENDER,
    recipient: RECIPIENT,
    amount: '10',
    asset: 'CXLM',
    unlockLedger: 200,
    refundAfter: 300,
    createdLedger: 100,
    txHash: 'hash',
    state,
  };
}

describe('vault state transitions', () => {
  it.each([
    [199, undefined, false, 'pending'],
    [200, undefined, false, 'claimable'],
    [299, undefined, false, 'claimable'],
    [300, undefined, false, 'expired'],
    [250, 'claimed', false, 'claimed'],
    [350, 'refunded', false, 'refunded'],
    [250, undefined, true, 'failed'],
  ] as const)('derives ledger %s as %s', (ledger, terminal, readFailed, expected) => {
    expect(deriveVaultState(ledger, 200, 300, terminal, readFailed)).toBe(expected);
  });

  it('only allows the recipient to claim during the claim window', () => {
    expect(getVaultActions(deposit('claimable'), RECIPIENT)).toEqual({
      canClaim: true,
      canRefund: false,
    });
    expect(getVaultActions(deposit('claimable'), SENDER).canClaim).toBe(false);
  });

  it('only allows the sender to refund after expiry', () => {
    expect(getVaultActions(deposit('expired'), SENDER)).toEqual({
      canClaim: false,
      canRefund: true,
    });
    expect(getVaultActions(deposit('expired'), RECIPIENT).canRefund).toBe(false);
  });

  it('never exposes actions for terminal or failed deposits', () => {
    for (const state of ['claimed', 'refunded', 'failed'] as const) {
      expect(getVaultActions(deposit(state), SENDER)).toEqual({
        canClaim: false,
        canRefund: false,
      });
    }
  });
});
