import { describe, expect, it, vi, afterEach } from 'vitest';
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  bytesToHex,
  deriveStealthKeys,
  generateStealthAddress,
} from '@wraith-protocol/sdk/chains/stellar';
import type { Announcement } from '@wraith-protocol/sdk/chains/stellar';
import {
  VAULT_ANNOUNCE_SCHEME_ID,
  decodeVaultError,
  formatVaultAmount,
  scanVaultAnnouncements,
  fetchVaultDepositEvents,
  awaitVaultClaimConfirmation,
} from './vaultClaim';

function randomSignature(): Uint8Array {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return bytes;
}

function makeVaultAnnouncement(
  spendingPubKey: Uint8Array,
  viewingPubKey: Uint8Array,
  overrides: Partial<Announcement> = {},
): Announcement {
  const generated = generateStealthAddress(spendingPubKey, viewingPubKey);
  return {
    schemeId: VAULT_ANNOUNCE_SCHEME_ID,
    stealthAddress: generated.stealthAddress,
    caller: 'GARBAGECALLERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    ephemeralPubKey: bytesToHex(generated.ephemeralPubKey),
    metadata: bytesToHex(new Uint8Array([generated.viewTag])),
    ...overrides,
  };
}

describe('decodeVaultError', () => {
  it('maps known Soroban contract error codes to readable messages', () => {
    expect(decodeVaultError('HostError: Error(Contract, #4)')).toBe(
      'Deposit not found — it has likely already been claimed or refunded.',
    );
    expect(decodeVaultError('Error(Contract, #5)')).toBe(
      'This deposit has not reached its unlock ledger yet.',
    );
    expect(decodeVaultError('Error(Contract, #7)')).toBe(
      'This deposit does not belong to your derived stealth address.',
    );
  });

  it('falls back to a generic message for an unmapped contract error code', () => {
    expect(decodeVaultError('Error(Contract, #99)')).toBe('Soroban vault error #99');
  });

  it('strips a leading "Error:" prefix from unrecognized messages', () => {
    expect(decodeVaultError('Error: Network request failed')).toBe('Network request failed');
  });
});

describe('formatVaultAmount', () => {
  it('formats whole units without a decimal point', () => {
    expect(formatVaultAmount(100_0000000n, 7)).toBe('100');
  });

  it('formats fractional units and trims trailing zeros', () => {
    expect(formatVaultAmount(123_400000n, 7)).toBe('12.34');
  });

  it('formats a negative amount', () => {
    expect(formatVaultAmount(-25_0000000n, 7)).toBe('-25');
  });

  it('formats zero', () => {
    expect(formatVaultAmount(0n, 7)).toBe('0');
  });
});

describe('scanVaultAnnouncements', () => {
  const recipient = deriveStealthKeys(randomSignature());
  const stranger = deriveStealthKeys(randomSignature());

  it('matches a genuine vault-scheme announcement and derives the stealth private scalar', () => {
    const ann = makeVaultAnnouncement(recipient.spendingPubKey, recipient.viewingPubKey);

    const matches = scanVaultAnnouncements(
      [ann],
      recipient.viewingKey,
      recipient.spendingPubKey,
      recipient.spendingScalar,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].stealthAddress).toBe(ann.stealthAddress);
    expect(typeof matches[0].stealthPrivateScalar).toBe('bigint');
  });

  it('ignores scheme-1 (direct transfer) announcements', () => {
    const ann = makeVaultAnnouncement(recipient.spendingPubKey, recipient.viewingPubKey, {
      schemeId: 1,
    });

    const matches = scanVaultAnnouncements(
      [ann],
      recipient.viewingKey,
      recipient.spendingPubKey,
      recipient.spendingScalar,
    );

    expect(matches).toHaveLength(0);
  });

  it("does not match another recipient's vault deposit", () => {
    const ann = makeVaultAnnouncement(stranger.spendingPubKey, stranger.viewingPubKey);

    const matches = scanVaultAnnouncements(
      [ann],
      recipient.viewingKey,
      recipient.spendingPubKey,
      recipient.spendingScalar,
    );

    expect(matches).toHaveLength(0);
  });
});

describe('fetchVaultDepositEvents', () => {
  const VAULT_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses deposit events into typed records', async () => {
    const depositId = Buffer.alloc(32, 7);
    const sender = Keypair.random().publicKey();
    const asset = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

    const event = {
      topic: [
        xdr.ScVal.scvSymbol('deposit').toXDR('base64'),
        xdr.ScVal.scvBytes(depositId).toXDR('base64'),
      ],
      value: xdr.ScVal.scvVec([
        new Address(sender).toScVal(),
        nativeToScVal(500_0000000n, { type: 'i128' }),
        new Address(asset).toScVal(),
        nativeToScVal(123456, { type: 'u32' }),
      ]).toXDR('base64'),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ result: { events: [event] } }),
      })),
    );

    const events = await fetchVaultDepositEvents(
      'https://soroban-testnet.stellar.org',
      VAULT_CONTRACT_ID,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      depositId: bytesToHex(new Uint8Array(depositId)),
      sender,
      amount: 500_0000000n,
      asset,
      unlockLedger: 123456,
    });
  });

  it('returns an empty list when the events API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const events = await fetchVaultDepositEvents(
      'https://soroban-testnet.stellar.org',
      VAULT_CONTRACT_ID,
    );
    expect(events).toEqual([]);
  });
});

describe('awaitVaultClaimConfirmation', () => {
  it('resolves once the transaction reaches SUCCESS', async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    await expect(
      awaitVaultClaimConfirmation({ getTransaction }, 'deadbeef', { delayMs: 0 }),
    ).resolves.toBeUndefined();
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it('throws when the transaction fails on-chain', async () => {
    const getTransaction = vi.fn().mockResolvedValue({ status: 'FAILED' });

    await expect(
      awaitVaultClaimConfirmation({ getTransaction }, 'deadbeef', { delayMs: 0 }),
    ).rejects.toThrow(/failed on-chain/);
  });

  it('reports a pending timeout instead of success when the status never resolves', async () => {
    const getTransaction = vi.fn().mockResolvedValue({ status: 'NOT_FOUND' });

    await expect(
      awaitVaultClaimConfirmation({ getTransaction }, 'deadbeef', {
        delayMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/has not confirmed yet/);
    expect(getTransaction).toHaveBeenCalledTimes(3);
  });
});
