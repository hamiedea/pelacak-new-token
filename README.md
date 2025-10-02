# pelacak-new-token
bot ini mungkin akan ada beberapa versi

## persiapan sebelum menggunakan bot

### 1. Update OS dan alat dasar
``` bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git build-essential
```
### 2. Pasang Node.js 20 LTS dan pnpm
``` bash
  # Nodesource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
  # pnpm via corepack
sudo corepack enable
sudo corepack prepare pnpm@9 --activate
node -v && pnpm -v
```
### 3. buat atau masuk ke dalam folder !!

### 4. download script
``` bash
wget https://raw.githubusercontent.com/hamiedea/pelacak-new-token/main/monitor.ts
```
### 5. Inisialisasi proyek dan TypeScript
``` bash
pnpm init
pnpm add -D typescript tsx @types/node
pnpm tsc --init --target ES2020 --module ESNext --moduleResolution Node --outDir dist --rootDir .
```
### 6. Pasang dependensi runtime
``` bash
pnpm add @solana/web3.js @solana/spl-token p-limit dotenv
```
### 7. Tambah skrip ke `package.json`
``` bash
pnpm pkg set scripts.dev="tsx monitor.ts"
pnpm pkg set scripts.start="node --env-file=.env --enable-source-maps --no-warnings --loader tsx ./monitor.ts"
```
### 8. Buat file `.env`
``` bash
cat > .env << 'EOF'
  # Wajib
SOLANA_RPC=https://api.mainnet-beta.solana.com
  # Opsional
MINT=
CREATOR=
SIG_PAGE_CONCURRENCY=8
TX_CONCURRENCY=8
EOF
```
### 9. jalankan script
``` bash
pnpm tsx monitor.ts <MINT_PUBKEY>
```
