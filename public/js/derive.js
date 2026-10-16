// Dérivation HD des sous-adresses de dépôt par client.
//
// Une seule seed maîtresse (BIP39) -> chaque client reçoit un
// `wallet_index` unique -> une sous-adresse par crypto est dérivée
// à cet index. Le mapping unique_id <-> wallet_index <-> adresse
// est stocké en base (tables users + addresses).

const { HDNodeWallet, Mnemonic } = require("ethers");
const { HDKey } = require("@scure/bip32");
const { payments, networks } = require("bitcoinjs-lib");
const { base58 } = require("@scure/base");
const { ed25519 } = require("@noble/curves/ed25519");
const {
    keccak256,
    sha256,
    hmac: hmacHash
} = require("@noble/hashes/sha3");
const { sha512 } = require("@noble/hashes/sha512");
const { bytesToHex } = require("@noble/hashes/utils");

// =========================
// RESEAUX UTXO
// =========================

const UTXO_NETWORKS = {
    bitcoin: {
        messagePrefix: "\x18Bitcoin Signed Message:\n",
        bech32: "bc",
        bip32: { public: 0x0488b21e, private: 0x0488ade4 },
        pubKeyHash: 0x00,
        scriptHash: 0x05,
        wif: 0x80,
        path: "84'",  // segwit natif
        segwit: true
    },
    litecoin: {
        messagePrefix: "\x19Litecoin Signed Message:\n",
        bech32: "ltc",
        bip32: { public: 0x019da462, private: 0x019d9cfe },
        pubKeyHash: 0x30,
        scriptHash: 0x32,
        wif: 0xb0,
        path: "84'",
        segwit: true
    },
    dogecoin: {
        messagePrefix: "\x19Dogecoin Signed Message:\n",
        bech32: "doge",
        bip32: { public: 0x02facafd, private: 0x02fac398 },
        pubKeyHash: 0x1e,
        scriptHash: 0x16,
        wif: 0x9e,
        path: "44'",  // legacy
        segwit: false
    }
};

// =========================
// HELPERS
// =========================

function base58checkEncode(payload) {
    const checksum = sha256(sha256(payload)).slice(0, 4);
    return base58.encode(new Uint8Array([...payload, ...checksum]));
}

function ser32(value) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value, false);
    return buf;
}

// =========================
// SOLANA (SLIP-10 ed25519)
// =========================

function slip10Ed25519Derive(seed, path) {
    // master key
    let I = hmacHash(sha512, Buffer.from("ed25519 seed"), seed);
    let key = I.slice(0, 32);
    let chainCode = I.slice(32);

    for (const segment of path) {
        if (!segment.hardened) {
            throw new Error("ed25519 : seulement les indexes durcis sont supportés");
        }
        const data = new Uint8Array(1 + 32 + 4);
        data[0] = 0x00;
        data.set(key, 1);
        data.set(ser32(segment.index | 0x80000000), 33);

        I = hmacHash(sha512, chainCode, data);
        key = I.slice(0, 32);
        chainCode = I.slice(32);
    }

    return key;
}

function parsePath(path) {
    return path
        .split("/")
        .slice(1) // ignore le "m"
        .map((part) => {
            const hardened = part.endsWith("'");
            const index = parseInt(hardened ? part.slice(0, -1) : part, 10);
            return { index, hardened };
        });
}

// =========================
// MONERO
// =========================

const MONERO_NETWORK_BYTE = 0x12; // adresse standard mainnet
const MONERO_L = 2n ** 252n +
    27742317777372353535851937790883648493n;

// sc_reduce32 : réduit 32 octets modulo L (little-endian)
function scReduce32(bytes32) {
    let value = 0n;
    for (let i = 31; i >= 0; i--) {
        value = (value << 8n) | BigInt(bytes32[i]);
    }
    const reduced = value % MONERO_L;

    const out = new Uint8Array(32);
    let v = reduced;
    for (let i = 0; i < 32; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

// Encodage base58 spécifique Monero (blocs de 11 octets -> 8 caractères)
function moneroBase58Encode(data) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let result = "";

    const fullBlocks = Math.floor(data.length / 11);

    for (let b = 0; b < fullBlocks; b++) {
        const block = data.slice(b * 11, (b + 1) * 11);
        result += moneroBlockEncode(block, 8, alphabet);
    }

    const rest = data.length % 11;
    if (rest > 0) {
        const blockSize = Math.floor((rest * 8 + 10) / 11);
        const block = data.slice(fullBlocks * 11);
        result += moneroBlockEncode(block, blockSize, alphabet);
    }

    return result;
}

function moneroBlockEncode(block, size, alphabet) {
    let num = 0n;
    for (const byte of block) {
        num = (num << 8n) | BigInt(byte);
    }

    let out = "";
    for (let i = 0; i < size; i++) {
        out = alphabet[Number(num % 58n)] + out;
        num /= 58n;
    }
    return out;
}

function deriveMoneroAddress(seed, index) {
    // Clé de dépense : keccak(seed || index) réduite modulo L
    const indexBuf = ser32(index);
    const spendSeed = keccak256(
        new Uint8Array([...seed, ...indexBuf])
    );

    const spendSec = scReduce32(spendSeed);
    const viewSec = scReduce32(keccak256(spendSec));

    const spendPub = ed25519.ExtendedPoint.BASE
        .multiply(bytesToNumber(spendSec))
        .toRawBytes();
    const viewPub = ed25519.ExtendedPoint.BASE
        .multiply(bytesToNumber(viewSec))
        .toRawBytes();

    const payload = new Uint8Array(1 + 32 + 32);
    payload[0] = MONERO_NETWORK_BYTE;
    payload.set(spendPub, 1);
    payload.set(viewPub, 33);

    const checksum = keccak256(payload).slice(0, 4);
    const full = new Uint8Array([...payload, ...checksum]);

    return moneroBase58Encode(full);
}

function bytesToNumber(bytes) {
    let value = 0n;
    for (const byte of bytes) {
        value = (value << 8n) | BigInt(byte);
    }
    return value;
}

// =========================
// DERIVATION PAR CHAINE
// =========================

function deriveEvm(seed, mnemonic, index) {
    const path = `m/44'/60'/0'/0/${index}`;
    const wallet = HDNodeWallet.fromPhrase(
        mnemonic.phrase,
        mnemonic.password,
        path
    );
    return wallet.address;
}

function deriveUtxo(seed, index, networkName) {
    const network = UTXO_NETWORKS[networkName];
    const hd = HDKey.fromMasterSeed(seed).derive(
        `m/${network.path}'/0'/0'/0/${index}`
    );

    const pubkey = hd.publicKey;

    if (network.segwit) {
        return payments.p2wpkh({ pubkey, network }).address;
    }
    return payments.p2pkh({ pubkey, network }).address;
}

function deriveSolana(seed, index) {
    const path = `m/44'/501'/${index}'/0'`;
    const key = slip10Ed25519Derive(seed, parsePath(path));
    const pub = ed25519.getPublicKey(key);
    return base58.encode(pub);
}

function deriveTron(seed, index) {
    const hd = HDKey.fromMasterSeed(seed).derive(
        `m/44'/195'/0'/0/${index}`
    );

    const pub = hd.publicKey;
    // clé publique non compressée (65 octets, 0x04 || X || Y)
    const uncompressed = ed25519PointFromSec1(pub);

    const hash = keccak256(uncompressed.slice(1));
    const addr20 = hash.slice(12);

    const payload = new Uint8Array(21);
    payload[0] = 0x41; // préfixe TRON mainnet
    payload.set(addr20, 1);

    return base58checkEncode(payload);
}

// Convertit une clé publique compressée (33 octets) en non compressée
function ed25519PointFromSec1(compressed) {
    const { secp256k1 } = require("@noble/curves/secp256k1");
    const point = secp256k1.ProjectivePoint.fromHex(compressed);
    return point.toRawBytes(false);
}

// =========================
// POINT D'ENTREE
// =========================

function deriveSubAddresses(mnemonic, index) {
    // seed BIP39 (64 octets) commune à toutes les chaînes
    const { mnemonicToSeedSync } = require("@scure/bip39");
    const seed = mnemonicToSeedSync(mnemonic.phrase, mnemonic.password);

    return {
        ETH: deriveEvm(seed, mnemonic, index),
        POL: deriveEvm(seed, mnemonic, index),
        BTC: deriveUtxo(seed, index, "bitcoin"),
        LTC: deriveUtxo(seed, index, "litecoin"),
        DOGE: deriveUtxo(seed, index, "dogecoin"),
        SOL: deriveSolana(seed, index),
        TRX: deriveTron(seed, index),
        XMR: deriveMoneroAddress(seed, index)
    };
}

module.exports = { deriveSubAddresses, deriveEvm, deriveUtxo, deriveSolana, deriveTron, deriveMoneroAddress };