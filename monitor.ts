// monitor_mint_window.ts
import "dotenv/config";
import { Connection, PublicKey, ConfirmedSignatureInfo } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import pLimit from "p-limit";

type Bin = { trades: number; volumeLamports: bigint };
type Balance = Map<string, bigint>;

function binIndexWith30s(tsSec: number, t0Sec: number): number {
  if (tsSec <= t0Sec + 30) return 0;
  const delta = tsSec - t0Sec;
  const m = Math.ceil(delta / 60);
  return Math.min(10, Math.max(1, m));
}

async function earliestSignatureByBlockTime(
  conn: Connection,
  addr: PublicKey,
  maxPages = 200
): Promise<ConfirmedSignatureInfo | null> {
  let before: string | undefined = undefined;
  let oldestSig: ConfirmedSignatureInfo | null = null;

  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    const page = await conn.getSignaturesForAddress(addr, { before, limit: 1000 }, "finalized");
    if (page.length === 0) break;
    oldestSig = page[page.length - 1];
    before = oldestSig.signature;
    if (page.length < 1000) break;
  }

  const head = await conn.getSignaturesForAddress(addr, { limit: 1000 }, "finalized");
  let best: ConfirmedSignatureInfo | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  const candidates: ConfirmedSignatureInfo[] = [...head];
  if (oldestSig) candidates.push(oldestSig);
  for (const s of candidates) {
    if (typeof s.blockTime === "number" && s.blockTime < bestTime) {
      bestTime = s.blockTime;
      best = s;
    }
  }
  return best ?? oldestSig;
}

async function listTokenAccountsForMint(conn: Connection, mint: PublicKey): Promise<PublicKey[]> {
  const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: "finalized",
    filters: [
      { dataSize: 165 }, // SPL Token Account
      { memcmp: { offset: 0, bytes: mint.toBase58() } }, // mint field at offset 0
    ],
  });
  return accounts.map((a) => a.pubkey);
}

async function collectSignaturesInWindow(
  conn: Connection,
  addrs: PublicKey[],
  t0: number,
  tEnd: number,
  maxPagesPerAddr = 50
): Promise<Map<string, ConfirmedSignatureInfo>> {
  const out = new Map<string, ConfirmedSignatureInfo>();
  const limit = pLimit(Number(process.env.SIG_PAGE_CONCURRENCY ?? 8));

  await Promise.all(
    addrs.map((addr) =>
      limit(async () => {
        let before: string | undefined = undefined;
        for (let i = 0; i < maxPagesPerAddr; i++) {
          const page = await conn.getSignaturesForAddress(addr, { before, limit: 1000 }, "finalized");
          if (page.length === 0) break;

          for (const s of page) {
            const bt = s.blockTime;
            if (typeof bt !== "number") continue;
            if (bt >= t0 && bt <= tEnd) {
              out.set(s.signature, s);
            }
          }

          const oldest = page[page.length - 1];
          before = oldest.signature;
          const btOld = oldest.blockTime;
          if (typeof btOld === "number" && btOld < t0) break;
          if (page.length < 1000) break;
        }
      })
    )
  );

  return out;
}

function toSOL(lamports: bigint): number {
  // Hindari overflow Number untuk nilai sangat besar secara praktis masih aman untuk jendela 10 menit
  return Number(lamports) / 1e9;
}

async function main() {
  const MINT_STR = process.argv[2] || process.env.MINT;
  if (!MINT_STR) {
    console.error("Gunakan: pnpm tsx monitor_mint_window.ts <MINT> [RPC_URL]");
    process.exit(1);
  }
  const RPC_URL =
    process.argv[3] ||
    process.env.SOLANA_RPC ||
    "https://api.mainnet-beta.solana.com";

  const CREATOR = process.env.CREATOR || ""; // opsional: owner wallet untuk hitung % hold

  const conn = new Connection(RPC_URL, { commitment: "finalized" });
  const mintPk = new PublicKey(MINT_STR);

  const ai = await conn.getAccountInfo(mintPk, "finalized");
  if (!ai) throw new Error(`Akun mint tidak ditemukan: ${MINT_STR}`);

  const genesis = await earliestSignatureByBlockTime(conn, mintPk);
  if (!genesis || typeof genesis.blockTime !== "number") {
    throw new Error("Tidak bisa menentukan t0.");
  }
  const t0 = genesis.blockTime;
  const tEnd = t0 + 10 * 60;

  // Kumpulkan semua token accounts (ATA) untuk mint
  const tokenAccounts = await listTokenAccountsForMint(conn, mintPk);

  // Ambil semua signature pada window dari seluruh token accounts
  const sigMap = await collectSignaturesInWindow(conn, tokenAccounts, t0, tEnd);
  const sigs = Array.from(sigMap.values()).sort((a, b) => (a.blockTime! - b.blockTime!));

  // Siapkan struktur agregasi
  const bins: Bin[] = Array.from({ length: 11 }, () => ({ trades: 0, volumeLamports: 0n }));
  const balances: Balance = new Map(); // owner -> amount bigint
  const snapshotHolders: number[] = Array(11).fill(0);
  const snapshotCreatorPct: (number | null)[] = Array(11).fill(null);

  const boundaries: number[] = [
    t0 + 30, t0 + 60, t0 + 120, t0 + 180, t0 + 240,
    t0 + 300, t0 + 360, t0 + 420, t0 + 480, t0 + 540, t0 + 600,
  ];
  let currentBin = 0;

  // Ambil transaksi secara paralel
  const limitTx = pLimit(Number(process.env.TX_CONCURRENCY ?? 8));
  const txs = await Promise.all(
    sigs.map((s) =>
      limitTx(() =>
        conn.getTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "finalized",
        })
      )
    )
  );

  for (let idx = 0; idx < sigs.length; idx++) {
    const s = sigs[idx];
    const ts = s.blockTime!;
    const tx = txs[idx];
    if (!tx || !tx.meta) continue;

    // SPL token delta per owner hanya untuk mint target
    const pre = tx.meta.preTokenBalances ?? [];
    const post = tx.meta.postTokenBalances ?? [];
    const preMap = new Map(pre.filter(b => b.mint === MINT_STR).map(b => [b.accountIndex, b]));
    const postMap = new Map(post.filter(b => b.mint === MINT_STR).map(b => [b.accountIndex, b]));
    const idxSet = new Set<number>([...preMap.keys(), ...postMap.keys()]);

    const deltas: Record<string, bigint> = {};
    for (const i of idxSet) {
      const preB = preMap.get(i);
      const postB = postMap.get(i);
      const owner = postB?.owner ?? preB?.owner;
      if (!owner) continue;
      const preAmt = BigInt(preB?.uiTokenAmount.amount ?? "0");
      const postAmt = BigInt(postB?.uiTokenAmount.amount ?? "0");
      const d = postAmt - preAmt;
      if (d !== 0n) deltas[owner] = (deltas[owner] ?? 0n) + d;
    }

    let hadMove = false;
    for (const d of Object.values(deltas)) if (d !== 0n) { hadMove = true; break; }

    // Update balances in-memory
    if (hadMove) {
      for (const [owner, d] of Object.entries(deltas)) {
        const cur = balances.get(owner) ?? 0n;
        const next = cur + d;
        if (next > 0n) balances.set(owner, next); else balances.delete(owner);
      }
    }

    // Perkiraan volume SOL dari delta lamports semua akun
    const preL = tx.meta.preBalances ?? [];
    const postL = tx.meta.postBalances ?? [];
    let solIn = 0n, solOut = 0n;
    for (let i = 0; i < Math.min(preL.length, postL.length); i++) {
      const diff = BigInt(postL[i]) - BigInt(preL[i]);
      if (diff > 0n) solIn += diff;
      else if (diff < 0n) solOut += -diff;
    }
    const fee = BigInt(tx.meta.fee ?? 0);
    if (solOut > fee) solOut -= fee;
    const txSolVol = solIn < solOut ? solIn : solOut;

    // Binning
    const b = binIndexWith30s(ts, t0);
    if (hadMove && txSolVol > 0n) {
      bins[b].trades += 1;
      bins[b].volumeLamports += txSolVol;
    }

    // Snapshot saat melewati boundary
    while (currentBin <= 10 && ts >= boundaries[currentBin]) {
      const holderCount = [...balances.values()].filter((v) => v > 0n).length;
      snapshotHolders[currentBin] = holderCount;

      if (CREATOR) {
        const creatorBal = balances.get(CREATOR) ?? 0n;
        const totalTracked = [...balances.values()].reduce((a, b) => a + b, 0n);
        snapshotCreatorPct[currentBin] =
          totalTracked > 0n ? (Number((creatorBal * 10000n) / totalTracked) / 100) : 0;
      }
      currentBin++;
    }
  }

  // Lengkapi snapshot sisa jika loop berakhir sebelum boundary terakhir
  while (currentBin <= 10) {
    const holderCount = [...balances.values()].filter((v) => v > 0n).length;
    snapshotHolders[currentBin] = holderCount;
    if (CREATOR) {
      const creatorBal = balances.get(CREATOR) ?? 0n;
      const totalTracked = [...balances.values()].reduce((a, b) => a + b, 0n);
      snapshotCreatorPct[currentBin] =
        totalTracked > 0n ? (Number((creatorBal * 10000n) / totalTracked) / 100) : 0;
    }
    currentBin++;
  }

  // Print
  console.log(`Mint: ${MINT_STR}`);
  console.log(`RPC : ${RPC_URL}`);
  console.log(`t0  : ${new Date(t0 * 1000).toISOString()}\n`);
  console.log("Window | Trades | Volume (SOL) | Holders" + (CREATOR ? " | Creator %" : ""));
  console.log("-------+--------+--------------+--------" + (CREATOR ? "+-----------" : ""));

  const printRow = (label: string, bin: Bin, holders: number, creatorPct: number | null) => {
    const vol = toSOL(bin.volumeLamports).toFixed(6);
    const base = `${label.padStart(6)} | ${bin.trades.toString().padStart(6)} | ${vol.padStart(12)} | ${holders.toString().padStart(7)}`;
    if (CREATOR) {
      const pct = creatorPct == null ? "" : `${creatorPct.toFixed(2)}%`;
      console.log(base + " | " + pct.padStart(9));
    } else {
      console.log(base);
    }
  };

  printRow("0:30", bins[0], snapshotHolders[0], snapshotCreatorPct[0]);
  for (let m = 1; m <= 10; m++) {
    printRow(`${m}`, bins[m], snapshotHolders[m], snapshotCreatorPct[m]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
