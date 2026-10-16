/*
 * tools/seed-products.js
 *
 * Ajoute des articles de démonstration dans la boutique.
 *
 * - Idempotent : un article déjà présent (même nom) n'est
 *   jamais dupliqué.
 * - Utilise la base de la boutique (database.sqlite), donc
 *   à exécuter depuis la racine du projet :
 *
 *       node tools/seed-products.js
 *
 * Les prix sont en ETH / BTC (les deux seules devises
 * acceptées par la boutique).
 */

const path = require("path");

const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "database.sqlite");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");


const PRODUCTS = [
    {
        name: "Ledger Nano X",
        description:
            "Portefeuille matériel Bluetooth, compatible ETH et BTC. " +
            "Livré avec câble USB-C.",
        price: "0.0235",
        currency: "ETH",
        stock: 12,
        image_url: "/images/mc-market-logo.png"
    },
    {
        name: "YubiKey 5 NFC",
        description:
            "Clé de sécurité matérielle : double authentification " +
            "et signature FIDO2.",
        price: "0.0118",
        currency: "ETH",
        stock: 20,
        image_url: "/images/mc-market-logo.png"
    },
    {
        name: "Raspberry Pi 5 - 8 Go",
        description:
            "Mini-serveur idéal pour faire tourner un noeud Ethereum " +
            "ou un full node Bitcoin.",
        price: "0.0087",
        currency: "ETH",
        stock: 15,
        image_url: "/images/mc-market-logo.png"
    },
    {
        name: "SSD NVMe 2 To",
        description:
            "Disque NVMe Gen4 pour la synchronisation de la " +
            "blockchain et le stockage de vos données.",
        price: "0.0052",
        currency: "ETH",
        stock: 25,
        image_url: "/images/mc-market-logo.png"
    },
    {
        name: "Coldcard Mk4",
        description:
            "Portefeuille matériel Bitcoin air-gapped, " +
            "signature hors ligne par carte SD.",
        price: "0.0095",
        currency: "BTC",
        stock: 7,
        image_url: "/images/mc-market-logo.png"
    },
    {
        name: "Seed Backup Kit (acier)",
        description:
            "Plaques en acier inoxydable pour graver et conserver " +
            "votre phrase de récupération.",
        price: "0.0034",
        currency: "BTC",
        stock: 30,
        image_url: "/images/mc-market-logo.png"
    }
];


const existing = db.prepare(
    "SELECT id FROM products WHERE name = ?"
);

const insert = db.prepare(`

    INSERT INTO products (
        name,
        description,
        price,
        currency,
        stock,
        image_url,
        active
    )
    VALUES (?, ?, ?, ?, ?, ?, 1)

`);


let created = 0;

let skipped = 0;

for (const product of PRODUCTS) {

    if (existing.get(product.name)) {
        skipped += 1;
        continue;
    }

    insert.run(
        product.name,
        product.description,
        product.price,
        product.currency,
        product.stock,
        product.image_url
    );

    created += 1;
}

console.log(
    "Articles de démonstration : " + created +
    " ajouté(s), " + skipped + " déjà présent(s)."
);

console.log(
    "Total en vente : " +
    db.prepare(
        "SELECT COUNT(*) AS total FROM products WHERE active = 1"
    ).get().total
);

db.close();
