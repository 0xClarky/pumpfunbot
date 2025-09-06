## Pump.fun Sell Bot (MVP)

Lightweight Solana bot that detects manual buys from your wallet, tracks PnL via Pump.fun bonding curve state, and auto-sells at TP/SL thresholds.

### Quick Start

1. Install deps:

   ```bash
   npm install
   ```

2. Copy env and fill values:

   ```bash
   cp .env.example .env
   # set HELIUS_API_KEY and SOLANA_PRIVATE_KEY
   ```

   - `SOLANA_PRIVATE_KEY` accepts: JSON array (solana-keygen), base58, or base64.

3. Run in dev:

   ```bash
   npm run dev
   ```

4. Build + run:

   ```bash
   npm run build && npm start
   ```

### Config

- `MAX_SLIPPAGE_BPS`: Max slippage for sells (default 1000 = 10%).
- `TP_PCT`: Take-profit percent as decimal (0.35 = +35%).
- `SL_PCT`: Stop-loss percent as decimal (-0.2 = -20%).
- `PRIORITY_FEE_SOL`: Priority fee in SOL (e.g., 0.01).
- `SKIP_PREFLIGHT`: Use `true` for speed.
- `SELL_STRATEGY`: `fixed` (TP/SL) or `trailing`.
- `TRAILING_SL_BPS`: When `SELL_STRATEGY=trailing`, basis points for trail (e.g., 3000 = 30%).
- `DETECTION_MODE`: `auto` (default), `ws`, or `poll`.
- `POLL_INTERVAL_MS`: Polling cadence for fallback or poll-only.
- `TRACKER_ENABLED`: Turn on/off PnL tracking loop.
- `SELL_ENABLED`: Allow automated sells when TP/SL hit.

### Notes

- MVP focuses on detection + sell logic. Auto-buy and LP/migration handling are out of scope.
- Primary RPC: Helius (HTTP + WebSocket).
- Logs stream to console and JSON file defined by `LOG_FILE`.

### Docker

Build and run:

```bash
docker build -t pumpfun-bot .
docker run --rm --env-file .env pumpfun-bot
```
