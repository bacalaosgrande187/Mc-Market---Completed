// Registre des crypto-monnaies supportées
// decimals = précision interne (montants stockés en unités mineures, BigInt)
// coingecko = id utilisé pour les prix
// family = moteur de dérivation d'adresse

const COINS = {
    BTC:  { decimals: 8,  coingecko: "bitcoin", family: "utxo", network: "bitcoin" },
    ETH:  { decimals: 18, coingecko: "ethereum", family: "evm" }
};

function isSupported(coin) {
    return Object.prototype.hasOwnProperty.call(COINS, coin);
}

function getInfo(coin) {
    return COINS[coin] || null;
}

function getDecimals(coin) {
    return COINS[coin].decimals;
}

// ---- Conversion décimal <-> unités mineures (BigInt) ----

function toMinor(amount, coin) {
    const decimals = getDecimals(coin);
    const str = String(amount).trim();

    if (!/^\d*(\.\d*)?$/.test(str) || str === "" || str === ".") {
        throw new Error("Montant invalide : " + amount);
    }

    const neg = str.startsWith("-");
    const [intPart = "", fracPart = ""] = str.replace("-", "").split(".");

    const fracPadded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
    let minor = BigInt(intPart + fracPadded);

    if (neg) minor = -minor;
    return minor;
}

function fromMinor(minor, coin) {
    const decimals = getDecimals(coin);
    const neg = minor < 0n;
    const abs = neg ? -minor : minor;
    const base = 10n ** BigInt(decimals);
    const intPart = abs / base;
    const fracPart = abs % base;

    const fracStr = decimals > 0
        ? "." + fracPart.toString().padStart(decimals, "0").replace(/0+$/, "")
        : "";

    return (neg ? "-" : "") + intPart.toString() + fracStr;
}

module.exports = { COINS, isSupported, getInfo, getDecimals, toMinor, fromMinor };