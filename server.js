require("dotenv").config();

const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const {
    HDNodeWallet,
    Wallet,
    JsonRpcProvider,
    isAddress,
    parseEther,
    formatEther,
    getAddress
} = require("ethers");

const bip39 = require("bip39");

const ecc = require("tiny-secp256k1");
const { BIP32Factory } = require("bip32");

const bitcoin = require("bitcoinjs-lib");

const {
    Keypair,
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction
} = require("@solana/web3.js");

const {
    derivePath
} = require("ed25519-hd-key");

const {
    TronWeb
} = require("tronweb");


// =====================================================
// APP
// =====================================================

const app = express();

const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({
    extended: true
}));

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


// =====================================================
// DATABASE
// =====================================================

const db = new Database("database.sqlite");

db.pragma("journal_mode = WAL");

db.pragma("foreign_keys = ON");


db.exec(`
    CREATE TABLE IF NOT EXISTS users (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        username TEXT NOT NULL UNIQUE,

        email TEXT NOT NULL UNIQUE,

        password_hash TEXT NOT NULL,

        created_at TEXT NOT NULL
            DEFAULT CURRENT_TIMESTAMP
    )
`);


db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        user_id INTEGER NOT NULL,

        network TEXT NOT NULL,

        address TEXT NOT NULL,

        derivation_index INTEGER NOT NULL,

        created_at TEXT NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE,

        UNIQUE(user_id, network),

        UNIQUE(network, derivation_index)
    )
`);


db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        user_id INTEGER NOT NULL,

        network TEXT NOT NULL,

        tx_hash TEXT NOT NULL UNIQUE,

        from_address TEXT NOT NULL,

        to_address TEXT NOT NULL,

        amount TEXT NOT NULL,

        status TEXT NOT NULL DEFAULT 'submitted',

        created_at TEXT NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    )
`);


console.log("SQLite connectée.");


// =====================================================
// MC MARKET : RÔLES + PRODUITS + COMMANDES
// =====================================================

/*
 * Migration : colonne role sur users.
 * 'client' par défaut, 'admin' pour la gestion du marché.
 */

const userColumns = db.pragma("table_info(users)");

if (!userColumns.some(col => col.name === "role")) {

    db.exec(
        "ALTER TABLE users " +
        "ADD COLUMN role TEXT NOT NULL DEFAULT 'client'"
    );

    console.log("Colonne 'role' ajoutée à users.");
}


db.exec(`
    CREATE TABLE IF NOT EXISTS products (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        name TEXT NOT NULL,

        description TEXT NOT NULL DEFAULT '',

        price TEXT NOT NULL,

        currency TEXT NOT NULL,

        stock INTEGER NOT NULL DEFAULT 0,

        image_url TEXT NOT NULL DEFAULT '',

        active INTEGER NOT NULL DEFAULT 1,

        created_at TEXT NOT NULL
            DEFAULT CURRENT_TIMESTAMP
    )
`);


db.exec(`
    CREATE TABLE IF NOT EXISTS orders (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        user_id INTEGER NOT NULL,

        product_id INTEGER NOT NULL,

        product_name TEXT NOT NULL,

        quantity INTEGER NOT NULL,

        unit_price TEXT NOT NULL,

        currency TEXT NOT NULL,

        total TEXT NOT NULL,

        payment_network TEXT NOT NULL,

        tx_hash TEXT,

        from_address TEXT,

        to_address TEXT,

        status TEXT NOT NULL DEFAULT 'paid',

        created_at TEXT NOT NULL
            DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    )
`);


/*
 * Migration : adresse de livraison sur les commandes.
 * Le client la saisit au moment du paiement.
 */

const orderColumns = db.pragma("table_info(orders)");

if (
    !orderColumns.some(
        col => col.name === "delivery_address"
    )
) {

    db.exec(
        "ALTER TABLE orders " +
        "ADD COLUMN delivery_address TEXT NOT NULL DEFAULT ''"
    );

    console.log(
        "Colonne 'delivery_address' ajoutée à orders."
    );
}


/*
 * Réseaux autorisés dans le wallet du client.
 * Seuls ethereum (ETH) et bitcoin (BTC) sont
 * conservés : les autres réseaux ont été retirés.
 */

const SUPPORTED_WALLET_NETWORKS = [

    "ethereum",

    "bitcoin"
];


/*
 * Devises acceptées pour les articles.
 * Chaque devise correspond à un réseau qui
 * supporte l'envoi réel depuis le wallet.
 */

const PRODUCT_CURRENCIES = {

    ETH: "ethereum",

    BTC: "bitcoin"
};


const NETWORK_SYMBOLS = {

    ethereum: "ETH",

    bitcoin: "BTC"
};


/*
 * Vérifie qu'un utilisateur est bien admin
 * (rôle + mot de passe correct).
 */

async function verifyAdmin(userId, password) {

    const id = Number(userId);

    if (!Number.isInteger(id)) {
        return null;
    }

    const user = db.prepare(
        "SELECT * FROM users WHERE id = ?"
    ).get(id);

    if (!user || user.role !== "admin") {
        return null;
    }

    const valid = await bcrypt.compare(
        String(password || ""),
        user.password_hash
    );

    if (!valid) {
        return null;
    }

    return user;
}


/*
 * Adresse qui reçoit les paiements de la boutique.
 * Priorité : STORE_ADDRESS_<RESEAU> dans .env,
 * sinon la wallet du premier compte admin.
 */

function getStoreAddress(network) {

    const envKey =
        "STORE_ADDRESS_" + network.toUpperCase();

    if (process.env[envKey]) {
        return process.env[envKey].trim();
    }

    const admin = db.prepare(`

        SELECT id

        FROM users

        WHERE role = 'admin'

        ORDER BY id ASC

    `).get();

    if (admin) {

        const wallet = db.prepare(`

            SELECT address

            FROM wallets

            WHERE user_id = ?

            AND network = ?

        `).get(admin.id, network);

        if (wallet) {
            return wallet.address;
        }
    }

    return null;
}


/*
 * Base de l'API mempool.space utilisée pour
 * Bitcoin (solde, UTXO, frais, diffusion).
 */

function btcApiBase() {

    const url =
        (NETWORK_CONFIG.bitcoin.rpc || "").trim();

    return url.replace(/\/+$/, "");
}


/*
 * Appel HTTP JSON vers l'API Bitcoin.
 */

async function btcApiFetch(
    url,
    options
) {

    const response =
        await fetch(url, options || {});

    const text =
        await response.text();

    if (!response.ok) {

        throw new Error(
            "API Bitcoin " + response.status + " : " +
            text.slice(0, 200)
        );
    }

    return text;
}


async function btcApiGetJson(url) {

    return JSON.parse(
        await btcApiFetch(url)
    );
}


/*
 * Lecture du solde on-chain d'une adresse.
 * Retourne null si le RPC n'est pas configuré.
 */

async function fetchBalance(network, address) {

    if (
        network === "ethereum"
        ||
        network === "polygon"
    ) {

        const rpc = NETWORK_CONFIG[network].rpc;

        if (!rpc) return null;

        const provider = new JsonRpcProvider(rpc);

        const balance =
            await provider.getBalance(address);

        return Number(formatEther(balance));
    }


    if (network === "bitcoin") {

        const base = btcApiBase();

        if (!base) return null;

        const data =
            await btcApiGetJson(
                base + "/address/" + address
            );

        const stats =
            data.chain_stats || {};

        const funded =
            Number(stats.funded_txo_sum || 0);

        const spent =
            Number(stats.spent_txo_sum || 0);

        return (funded - spent) / 100000000;
    }


    if (network === "solana") {

        const rpc = NETWORK_CONFIG.solana.rpc;

        if (!rpc) return null;

        const connection = new Connection(rpc, "confirmed");

        const lamports =
            await connection.getBalance(
                new PublicKey(address)
            );

        return lamports / 1_000_000_000;
    }


    if (network === "tron") {

        const rpc = NETWORK_CONFIG.tron.rpc;

        if (!rpc) return null;

        const tron = new TronWeb({ fullHost: rpc });

        const sun = await tron.trx.getBalance(address);

        return Number(sun || 0) / 1_000_000;
    }


    return null;
}


/*
 * Création automatique du compte admin au démarrage.
 * Personnalisable via ADMIN_EMAIL / ADMIN_USERNAME /
 * ADMIN_PASSWORD dans le .env.
 */

(async () => {

    const adminEmail = (
        process.env.ADMIN_EMAIL
        || "admin@mcmarket.io"
    ).trim().toLowerCase();

    const adminUsername = (
        process.env.ADMIN_USERNAME
        || "admin"
    ).trim();

    const adminPassword =
        process.env.ADMIN_PASSWORD
        || "McMarket2026!";


    const existing = db.prepare(`

        SELECT id, role

        FROM users

        WHERE email = ?

        OR username = ?

    `).get(adminEmail, adminUsername);


    if (existing) {

        db.prepare(
            "UPDATE users SET role = 'admin' WHERE id = ?"
        ).run(existing.id);

        console.log(
            "Compte admin existant promu : " + adminEmail
        );

        return;
    }


    const passwordHash =
        await bcrypt.hash(adminPassword, 12);


    const result = db.prepare(`

        INSERT INTO users (
            username,
            email,
            password_hash,
            role
        )

        VALUES (?, ?, ?, 'admin')

    `).run(adminUsername, adminEmail, passwordHash);


    const adminId = Number(result.lastInsertRowid);

    createUserWallets(adminId, adminId);


    console.log("========================================");
    console.log("Compte ADMIN Mc Market créé :");
    console.log("  Email        : " + adminEmail);
    console.log("  Mot de passe : " + adminPassword);
    console.log("  (à modifier via ADMIN_EMAIL / ADMIN_PASSWORD)");
    console.log("========================================");

})();


// =====================================================
// ENVIRONMENT
// =====================================================

if (!process.env.MNEMONIC) {

    console.error(
        "ERREUR : MNEMONIC absent du .env"
    );

    process.exit(1);
}


const MNEMONIC =
    process.env.MNEMONIC.trim();


if (!bip39.validateMnemonic(MNEMONIC)) {

    console.error(
        "ERREUR : MNEMONIC invalide."
    );

    process.exit(1);
}


const masterSeed =
    bip39.mnemonicToSeedSync(MNEMONIC);


// =====================================================
// BIP32
// =====================================================

const bip32 =
    BIP32Factory(ecc);


// =====================================================
// NETWORK CONFIG
// =====================================================

const NETWORK_CONFIG = {

    ethereum: {

        type: "evm",

        rpc: process.env.ETH_RPC_URL,

        chainId: 1,

        coinType: 60
    },


    polygon: {

        type: "evm",

        rpc: process.env.POLYGON_RPC_URL,

        chainId: 137,

        coinType: 60
    },


    solana: {

        type: "solana",

        rpc: process.env.SOL_RPC_URL,

        coinType: 501
    },


    tron: {

        type: "tron",

        rpc: process.env.TRON_RPC_URL,

        coinType: 195
    },


    bitcoin: {

        type: "utxo",

        rpc: process.env.BTC_RPC_URL,

        coinType: 0,

        purpose: 84
    },


    litecoin: {

        type: "utxo",

        rpc: process.env.LTC_RPC_URL,

        coinType: 2,

        purpose: 84
    },


    dogecoin: {

        type: "utxo",

        rpc: process.env.DOGE_RPC_URL,

        coinType: 3,

        purpose: 44
    }
};


// =====================================================
// NETWORK DEFINITIONS
// =====================================================

const BITCOIN_NETWORK = {

    messagePrefix:
        "\x18Bitcoin Signed Message:\n",

    bech32: "bc",

    bip32: {

        public: 0x0488b21e,

        private: 0x0488ade4
    },

    pubKeyHash: 0x00,

    scriptHash: 0x05,

    wif: 0x80
};


const LITECOIN_NETWORK = {

    messagePrefix:
        "\x19Litecoin Signed Message:\n",

    bech32: "ltc",

    bip32: {

        public: 0x019da462,

        private: 0x019d9cfe
    },

    pubKeyHash: 0x30,

    scriptHash: 0x32,

    wif: 0xb0
};


const DOGECOIN_NETWORK = {

    messagePrefix:
        "\x19Dogecoin Signed Message:\n",

    bip32: {

        public: 0x02facafd,

        private: 0x02fac398
    },

    pubKeyHash: 0x1e,

    scriptHash: 0x16,

    wif: 0x9e
};


// =====================================================
// EVM PRIVATE KEY
// =====================================================

function deriveEVMWallet(
    coinType,
    index
) {

    const path =
        `m/44'/${coinType}'/0'/0/${index}`;


    const wallet =
        HDNodeWallet
            .fromSeed(masterSeed)
            .derivePath(path);


    return {

        address: wallet.address,

        privateKey: wallet.privateKey,

        path
    };
}


// =====================================================
// ETHEREUM
// =====================================================

function deriveEthereum(index) {

    return deriveEVMWallet(
        60,
        index
    );
}


// =====================================================
// POLYGON
// =====================================================

function derivePolygon(index) {

    return deriveEVMWallet(
        60,
        index
    );
}


// =====================================================
// BITCOIN
// =====================================================

function deriveBitcoin(index) {

    const path =
        `m/84'/0'/0'/0/${index}`;


    const node =
        bip32
            .fromSeed(
                Buffer.from(masterSeed),
                BITCOIN_NETWORK
            )
            .derivePath(path);


    const payment =
        bitcoin.payments.p2wpkh({

            pubkey:
                Buffer.from(
                    node.publicKey
                ),

            network:
                BITCOIN_NETWORK
        });


    return {

        address:
            payment.address,

        privateKey:
            node.toWIF(),

        path
    };
}


// =====================================================
// LITECOIN
// =====================================================

function deriveLitecoin(index) {

    const path =
        `m/84'/2'/0'/0/${index}`;


    const node =
        bip32
            .fromSeed(
                Buffer.from(masterSeed),
                LITECOIN_NETWORK
            )
            .derivePath(path);


    const payment =
        bitcoin.payments.p2wpkh({

            pubkey:
                Buffer.from(
                    node.publicKey
                ),

            network:
                LITECOIN_NETWORK
        });


    return {

        address:
            payment.address,

        privateKey:
            node.toWIF(),

        path
    };
}


// =====================================================
// DOGECOIN
// =====================================================

function deriveDogecoin(index) {

    const path =
        `m/44'/3'/0'/0/${index}`;


    const node =
        bip32
            .fromSeed(
                Buffer.from(masterSeed),
                DOGECOIN_NETWORK
            )
            .derivePath(path);


    const payment =
        bitcoin.payments.p2pkh({

            pubkey:
                Buffer.from(
                    node.publicKey
                ),

            network:
                DOGECOIN_NETWORK
        });


    return {

        address:
            payment.address,

        privateKey:
            node.toWIF(),

        path
    };
}


// =====================================================
// SOLANA
// =====================================================

function deriveSolana(index) {

    const path =
        `m/44'/501'/${index}'/0'`;


    const derived =
        derivePath(

            path,

            Buffer.from(
                masterSeed
            ).toString("hex")
        );


    const keypair =
        Keypair.fromSeed(
            derived.key
        );


    return {

        address:
            keypair.publicKey.toBase58(),

        privateKey:
            Buffer.from(
                keypair.secretKey
            ),

        keypair,

        path
    };
}


// =====================================================
// TRON
// =====================================================

function deriveTron(index) {

    const path =
        `m/44'/195'/0'/0/${index}`;


    const wallet =
        HDNodeWallet
            .fromSeed(masterSeed)
            .derivePath(path);


    const tronAddress =
        TronWeb.address.fromPrivateKey(
            wallet.privateKey
        );


    return {

        address:
            tronAddress,

        privateKey:
            wallet.privateKey,

        path
    };
}


// =====================================================
// GENERATE ALL USER WALLETS
// =====================================================
//
// Seuls ethereum et bitcoin sont générés :
// les autres réseaux ont été retirés du wallet.
//

function deriveAllWallets(index) {

    const wallets = [];


    // ETH

    const eth =
        deriveEthereum(index);


    wallets.push({

        network:
            "ethereum",

        address:
            eth.address,

        derivationIndex:
            index
    });


    // BTC

    const btc =
        deriveBitcoin(index);


    wallets.push({

        network:
            "bitcoin",

        address:
            btc.address,

        derivationIndex:
            index
    });


    return wallets;
}


// =====================================================
// CREATE USER WALLETS
// =====================================================

function createUserWallets(
    userId,
    index
) {

    const wallets =
        deriveAllWallets(index);


    const insert =
        db.prepare(`

            INSERT INTO wallets (

                user_id,

                network,

                address,

                derivation_index

            )

            VALUES (?, ?, ?, ?)

        `);


    const transaction =
        db.transaction(() => {

            for (
                const wallet
                of wallets
            ) {

                insert.run(

                    userId,

                    wallet.network,

                    wallet.address,

                    wallet.derivationIndex

                );
            }
        });


    transaction();


    return wallets;
}


// =====================================================
// REGISTER
// =====================================================

app.post(
    "/api/register",
    async (req, res) => {

        try {

            const username =
                String(
                    req.body.username || ""
                ).trim();


            const email =
                String(
                    req.body.email || ""
                )
                .trim()
                .toLowerCase();


            const password =
                String(
                    req.body.password || ""
                );


            if (
                !username ||
                !email ||
                !password
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Tous les champs sont obligatoires."
                });
            }


            if (username.length < 3) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Username trop court."
                });
            }


            if (password.length < 8) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Mot de passe trop court."
                });
            }


            const existing =
                db.prepare(`

                    SELECT id

                    FROM users

                    WHERE email = ?

                    OR username = ?

                `).get(
                    email,
                    username
                );


            if (existing) {

                return res.status(409).json({

                    success: false,

                    message:
                        "Email ou username déjà utilisé."
                });
            }


            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );


            const result =
                db.prepare(`

                    INSERT INTO users (

                        username,

                        email,

                        password_hash

                    )

                    VALUES (?, ?, ?)

                `).run(

                    username,

                    email,

                    passwordHash
                );


            const userId =
                Number(
                    result.lastInsertRowid
                );


            /*
             * IMPORTANT
             *
             * Chaque utilisateur possède
             * son propre index HD.
             */

            const derivationIndex =
                userId;


            const wallets =
                createUserWallets(

                    userId,

                    derivationIndex
                );


            console.log(
                `Utilisateur créé : ${username}`
            );


            return res.status(201).json({

                success: true,

                message:
                    "Compte et wallets créés.",

                userId,

                wallets
            });


        } catch (error) {

            console.error(
                "REGISTER ERROR:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Erreur interne."
            });
        }
    }
);


// =====================================================
// LOGIN
// =====================================================

app.post(
    "/api/login",
    async (req, res) => {

        try {

            const email =
                String(
                    req.body.email || ""
                )
                .trim()
                .toLowerCase();


            const password =
                String(
                    req.body.password || ""
                );


            if (
                !email ||
                !password
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email et mot de passe requis."
                });
            }


            const user =
                db.prepare(`

                    SELECT *

                    FROM users

                    WHERE email = ?

                `).get(email);


            if (!user) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Email ou mot de passe incorrect."
                });
            }


            const valid =
                await bcrypt.compare(

                    password,

                    user.password_hash
                );


            if (!valid) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Email ou mot de passe incorrect."
                });
            }


            const wallets =
                db.prepare(`

                    SELECT

                        network,

                        address,

                        derivation_index

                    FROM wallets

                    WHERE user_id = ?

                    ORDER BY network

                `).all(user.id)
                .filter(
                    wallet =>
                        SUPPORTED_WALLET_NETWORKS.includes(
                            wallet.network
                        )
                );


            return res.json({

                success: true,

                message:
                    "Connexion réussie.",

                user: {

                    id:
                        user.id,

                    username:
                        user.username,

                    email:
                        user.email,

                    role:
                        user.role || "client"
                },


                wallets:

                    wallets.map(
                        wallet => ({

                            network:
                                wallet.network,

                            address:
                                wallet.address,

                            derivationIndex:
                                wallet.derivation_index
                        })
                    )
            });


        } catch (error) {

            console.error(
                "LOGIN ERROR:",
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Erreur interne."
            });
        }
    }
);


// =====================================================
// GET WALLETS
// =====================================================

app.get(
    "/api/users/:id/wallets",
    (req, res) => {

        try {

            const userId =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(
                    userId
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "ID invalide."
                });
            }


            const wallets =
                db.prepare(`

                    SELECT

                        network,

                        address,

                        derivation_index,

                        created_at

                    FROM wallets

                    WHERE user_id = ?

                    ORDER BY network

                `).all(userId)
                .filter(
                    wallet =>
                        SUPPORTED_WALLET_NETWORKS.includes(
                            wallet.network
                        )
                );


            return res.json({

                success: true,

                wallets:

                    wallets.map(
                        wallet => ({

                            network:
                                wallet.network,

                            address:
                                wallet.address,

                            derivationIndex:
                                wallet.derivation_index,

                            createdAt:
                                wallet.created_at
                        })
                    )
            });


        } catch (error) {

            console.error(
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Erreur interne."
            });
        }
    }
);


// =====================================================
// INTERNAL: GET USER WALLET
// =====================================================

function getUserWallet(
    userId,
    network
) {

    const wallet =
        db.prepare(`

            SELECT *

            FROM wallets

            WHERE user_id = ?

            AND network = ?

        `).get(

            userId,

            network
        );


    if (!wallet) {

        throw new Error(
            "Wallet introuvable."
        );
    }


    return wallet;
}


// =====================================================
// INTERNAL: DERIVE PRIVATE KEY
// =====================================================

function derivePrivateKey(
    network,
    index
) {

    switch (network) {


        case "ethereum":

            return deriveEthereum(
                index
            );


        case "polygon":

            return derivePolygon(
                index
            );


        case "bitcoin":

            return deriveBitcoin(
                index
            );


        case "litecoin":

            return deriveLitecoin(
                index
            );


        case "dogecoin":

            return deriveDogecoin(
                index
            );


        case "solana":

            return deriveSolana(
                index
            );


        case "tron":

            return deriveTron(
                index
            );


        default:

            throw new Error(
                "Réseau non supporté."
            );
    }
}


// =====================================================
// SEND EVM
// ETHEREUM + POLYGON
// =====================================================

async function sendEVM(
    network,
    userWallet,
    to,
    amount
) {

    const config =
        NETWORK_CONFIG[network];


    if (!config.rpc) {

        throw new Error(
            `${network.toUpperCase()}_RPC_URL absent du .env`
        );
    }


    if (!isAddress(to)) {

        throw new Error(
            "Adresse Ethereum invalide."
        );
    }


    const provider =
        new JsonRpcProvider(
            config.rpc
        );


    // Vérification du réseau réel

    const chain =
        await provider.getNetwork();


    if (
        Number(chain.chainId)
        !==
        config.chainId
    ) {

        throw new Error(

            `Mauvais réseau RPC. ` +

            `Attendu chainId ${config.chainId}, ` +

            `reçu ${chain.chainId}.`
        );
    }


    const key =
        derivePrivateKey(

            network,

            userWallet.derivation_index
        );


    /*
     * new Wallet(...) et non new HDNodeWallet(...) :
     * le constructeur de HDNodeWallet n'est pas public
     * (1er argument = guard interne), passer la clé
     * directement levait "invalid private key".
     */

    const signer =
        new Wallet(
            key.privateKey,
            provider
        );


    const expectedAddress =
        getAddress(
            userWallet.address
        );


    if (
        getAddress(
            signer.address
        )
        !==
        expectedAddress
    ) {

        throw new Error(
            "Erreur : adresse dérivée différente de la base."
        );
    }


    const value =
        parseEther(
            String(amount)
        );


    const balance =
        await provider.getBalance(
            signer.address
        );


    const feeData =
        await provider.getFeeData();


    const gasLimit =
        await provider.estimateGas({

            from:
                signer.address,

            to:
                to,

            value:
                value
        });


    const gasPrice =
        feeData.gasPrice;


    if (!gasPrice) {

        throw new Error(
            "Impossible de récupérer le gas price."
        );
    }


    const gasCost =
        gasLimit *
        gasPrice;


    if (
        balance <
        value + gasCost
    ) {

        throw new Error(
            "Solde ETH insuffisant pour montant + gas."
        );
    }


    const tx =
        await signer.sendTransaction({

            to,

            value,

            gasLimit,

            gasPrice
        });


    await tx.wait();


    return {

        hash:
            tx.hash,

        from:
            signer.address,

        to,

        amount:
            String(amount)
    };
}


// =====================================================
// SEND BITCOIN (UTXO / PSBT)
// =====================================================

/*
 * Envoi natif Bitcoin :
 * - lecture des UTXO via mempool.space
 * - frais recommandés dynamiques
 * - construction et signature d'une PSBT (P2WPKH)
 * - diffusion de la transaction brute
 */

const BTC_DUST_LIMIT = 546;


function btcToSats(amount) {

    const sats =
        Math.round(Number(amount) * 100000000);

    if (!Number.isFinite(sats) || sats <= 0) {

        throw new Error("Montant BTC invalide.");
    }

    return sats;
}


async function sendBitcoin(
    userWallet,
    to,
    amount
) {

    const base =
        btcApiBase();

    if (!base) {

        throw new Error(
            "BTC_RPC_URL absent du .env"
        );
    }


    const from =
        userWallet.address;


    try {

        bitcoin.address.toOutputScript(
            to,
            BITCOIN_NETWORK
        );

    } catch (addressError) {

        throw new Error(
            "Adresse Bitcoin invalide."
        );
    }


    const value =
        btcToSats(amount);


    const script =
        bitcoin.address.toOutputScript(
            from,
            BITCOIN_NETWORK
        );


    // -----------------------------------------
    // UTXO
    // -----------------------------------------

    const utxos =
        await btcApiGetJson(
            base + "/address/" + from + "/utxo"
        );


    if (
        !Array.isArray(utxos)
        ||
        utxos.length === 0
    ) {

        throw new Error(
            "Solde BTC insuffisant : aucun UTXO disponible."
        );
    }


    // -----------------------------------------
    // FRAIS (sat/vB)
    // -----------------------------------------

    let feeRate = 2;

    try {

        const fees =
            await btcApiGetJson(
                base + "/v1/fees/recommended"
            );

        const candidate =
            Number(fees.halfHourFee)
            ||
            Number(fees.economyFee)
            ||
            Number(fees.hourFee);

        if (
            Number.isFinite(candidate)
            &&
            candidate > 0
        ) {

            feeRate = Math.ceil(candidate);
        }

    } catch (feeError) {

        console.error(
            "BTC FEE ERROR:",
            feeError.message
        );
    }


    // confirmés d'abord, puis les plus gros

    const sorted =
        utxos.slice().sort(
            (a, b) => {

                const ca =
                    a.status && a.status.confirmed ? 0 : 1;

                const cb =
                    b.status && b.status.confirmed ? 0 : 1;

                if (ca !== cb) {
                    return ca - cb;
                }

                return Number(b.value) - Number(a.value);
            }
        );


    // taille estimée d'une transaction P2WPKH

    const estimateSize =
        (inputs, outputs) =>
            inputs * 68 + outputs * 31 + 11;


    const selected = [];

    let totalIn = 0;
    let fee = 0;
    let change = 0;
    let funded = false;


    for (const utxo of sorted) {

        selected.push(utxo);

        totalIn += Number(utxo.value);


        const feeWithChange =
            estimateSize(selected.length, 2) * feeRate;

        const feeNoChange =
            estimateSize(selected.length, 1) * feeRate;


        if (
            totalIn - value - feeWithChange
            >= BTC_DUST_LIMIT
        ) {

            fee = feeWithChange;

            change = totalIn - value - feeWithChange;

            funded = true;

            break;
        }


        if (totalIn - value - feeNoChange >= 0) {

            /*
             * Reliquat sous le seuil de poussière :
             * il est absorbé par les frais plutôt que
             * de créer une sortie inutilisable.
             */

            fee = totalIn - value;

            change = 0;

            funded = true;

            break;
        }
    }


    if (!funded) {

        throw new Error(
            "Solde BTC insuffisant pour couvrir le montant " +
            "et les frais de réseau."
        );
    }


    // -----------------------------------------
    // CLE PRIVEE
    // -----------------------------------------

    const key =
        derivePrivateKey(
            "bitcoin",
            userWallet.derivation_index
        );


    if (key.address !== from) {

        throw new Error(
            "Erreur : adresse dérivée différente de la base."
        );
    }


    const masterNode =
        bip32.fromSeed(
            Buffer.from(masterSeed),
            BITCOIN_NETWORK
        );

    const hdNode =
        masterNode.derivePath(key.path);


    /*
     * La signature HD exige que chaque entrée
     * déclare sa dérivation (fingerprint + chemin).
     */

    const bip32Derivation = [
        {
            masterFingerprint:
                Buffer.from(masterNode.fingerprint),

            pubkey:
                Buffer.from(hdNode.publicKey),

            path:
                key.path
        }
    ];


    // -----------------------------------------
    // PSBT
    // -----------------------------------------

    const psbt =
        new bitcoin.Psbt({
            network: BITCOIN_NETWORK
        });


    for (const utxo of selected) {

        psbt.addInput({

            hash:
                utxo.txid,

            index:
                Number(utxo.vout),

            witnessUtxo: {

                script: script,

                value: BigInt(
                    Math.round(Number(utxo.value))
                )
            },

            bip32Derivation: bip32Derivation
        });
    }


    psbt.addOutput({

        address: to,

        value: BigInt(value)
    });


    if (change > 0) {

        psbt.addOutput({

            address: from,

            value: BigInt(change)
        });
    }


    psbt.signAllInputsHD(masterNode);


    psbt.validateSignaturesOfAllInputs(
        (pubkey, msghash, signature) =>
            ecc.verify(msghash, pubkey, signature)
    );


    psbt.finalizeAllInputs();


    const tx =
        psbt.extractTransaction();


    // -----------------------------------------
    // DIFFUSION
    // -----------------------------------------

    const broadcasted =
        await btcApiFetch(
            base + "/tx",
            {
                method: "POST",

                headers: {
                    "Content-Type": "text/plain"
                },

                body: tx.toHex()
            }
        );


    return {

        hash:
            String(
                broadcasted || tx.getId()
            ).trim(),

        from,

        to,

        amount:
            String(value / 100000000),

        fee:
            String(fee / 100000000),

        change:
            String(change / 100000000)
    };
}


// =====================================================
// SEND SOLANA
// =====================================================

async function sendSolana(
    userWallet,
    to,
    amount
) {

    const config =
        NETWORK_CONFIG.solana;


    if (!config.rpc) {

        throw new Error(
            "SOL_RPC_URL absent du .env"
        );
    }


    const connection =
        new Connection(
            config.rpc,
            "confirmed"
        );


    const derived =
        deriveSolana(
            userWallet.derivation_index
        );


    const fromPublicKey =
        derived.keypair.publicKey;


    const destination =
        new PublicKey(to);


    /*
     * amount est en SOL.
     */

    const lamports =
        Math.round(
            Number(amount)
            * 1_000_000_000
        );


    if (
        !Number.isSafeInteger(
            lamports
        )
        ||
        lamports <= 0
    ) {

        throw new Error(
            "Montant SOL invalide."
        );
    }


    const transaction =
        new Transaction().add(

            SystemProgram.transfer({

                fromPubkey:
                    fromPublicKey,

                toPubkey:
                    destination,

                lamports
            })
        );


    const signature =
        await sendAndConfirmTransaction(

            connection,

            transaction,

            [
                derived.keypair
            ]
        );


    return {

        hash:
            signature,

        from:
            fromPublicKey.toBase58(),

        to,

        amount:
            String(amount)
    };
}


// =====================================================
// SEND TRON
// =====================================================

async function sendTron(
    userWallet,
    to,
    amount
) {

    const config =
        NETWORK_CONFIG.tron;


    if (!config.rpc) {

        throw new Error(
            "TRON_RPC_URL absent du .env"
        );
    }


    const derived =
        deriveTron(
            userWallet.derivation_index
        );


    const tron =
        new TronWeb({

            fullHost:
                config.rpc,

            privateKey:
                derived.privateKey
        });


    if (
        !tron.isAddress(to)
    ) {

        throw new Error(
            "Adresse TRON invalide."
        );
    }


    /*
     * TRX utilise SUN.
     *
     * 1 TRX =
     * 1,000,000 SUN
     */

    const sun =
        Math.round(
            Number(amount)
            * 1_000_000
        );


    if (
        !Number.isSafeInteger(
            sun
        )
        ||
        sun <= 0
    ) {

        throw new Error(
            "Montant TRX invalide."
        );
    }


    const transaction =
        await tron.transactionBuilder
            .sendTrx(

                to,

                sun,

                derived.address
            );


    const signed =
        await tron.trx.sign(
            transaction,
            derived.privateKey
        );


    const result =
        await tron.trx.sendRawTransaction(
            signed
        );


    if (!result.result) {

        throw new Error(
            "TRON transaction refusée."
        );
    }


    return {

        hash:
            result.txid,

        from:
            derived.address,

        to,

        amount:
            String(amount)
    };
}


// =====================================================
// SEND WALLET
// =====================================================

app.post(
    "/api/wallet/send",
    async (req, res) => {

        try {

            const {

                userId,

                password,

                network,

                to,

                amount

            } = req.body;


            // -----------------------------------------
            // VALIDATION
            // -----------------------------------------

            const id =
                Number(userId);


            if (
                !Number.isInteger(id)
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "userId invalide."
                });
            }


            if (
                !password
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Mot de passe requis."
                });
            }


            if (
                !NETWORK_CONFIG[network]
                ||
                !SUPPORTED_WALLET_NETWORKS.includes(network)
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Réseau non supporté. Seuls ethereum (ETH) " +
                        "et bitcoin (BTC) sont disponibles."
                });
            }


            if (
                !to
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Adresse destination requise."
                });
            }


            if (
                !amount ||
                Number(amount) <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Montant invalide."
                });
            }


            // -----------------------------------------
            // USER
            // -----------------------------------------

            const user =
                db.prepare(`

                    SELECT *

                    FROM users

                    WHERE id = ?

                `).get(id);


            if (!user) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Utilisateur introuvable."
                });
            }


            // -----------------------------------------
            // PASSWORD
            // -----------------------------------------

            const valid =
                await bcrypt.compare(

                    password,

                    user.password_hash
                );


            if (!valid) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Mot de passe incorrect."
                });
            }


            // -----------------------------------------
            // USER WALLET
            // -----------------------------------------

            const userWallet =
                getUserWallet(

                    id,

                    network
                );


            // -----------------------------------------
            // TRANSACTION
            // -----------------------------------------

            let result;


            if (
                network === "ethereum"
                ||
                network === "polygon"
            ) {

                result =
                    await sendEVM(

                        network,

                        userWallet,

                        to,

                        amount
                    );
            }


            else if (
                network === "solana"
            ) {

                result =
                    await sendSolana(

                        userWallet,

                        to,

                        amount
                    );
            }


            else if (
                network === "tron"
            ) {

                result =
                    await sendTron(

                        userWallet,

                        to,

                        amount
                    );
            }


            else if (
                network === "bitcoin"
            ) {

                result =
                    await sendBitcoin(

                        userWallet,

                        to,

                        netAmount
                    );


                taxResult =
                    await sendBitcoin(

                        userWallet,

                        taxAddress,

                        taxAmount
                    );
            }


            else {

                /*
                 * Tout autre réseau a été retiré du wallet :
                 * seuls ETH et BTC restent disponibles.
                 */

                return res.status(400).json({

                    success: false,

                    message:
                        "Réseau non supporté. Seuls ethereum (ETH) " +
                        "et bitcoin (BTC) sont disponibles."
                });
            }


            // -----------------------------------------
            // SAVE TX
            // -----------------------------------------

            db.prepare(`

                INSERT INTO transactions (

                    user_id,

                    network,

                    tx_hash,

                    from_address,

                    to_address,

                    amount,

                    status

                )

                VALUES (?, ?, ?, ?, ?, ?, ?)

            `).run(

                id,

                network,

                result.hash,

                result.from,

                result.to,

                result.amount,

                "confirmed"
            );


            // -----------------------------------------
            // RESPONSE
            // -----------------------------------------

            return res.json({

                success: true,

                message:
                    "Transaction envoyée.",

                transaction: {

                    network,

                    hash:
                        result.hash,

                    from:
                        result.from,

                    to:
                        result.to,

                    amount:
                        result.amount
                }
            });


        } catch (error) {

            console.error(
                "SEND ERROR:",
                error
            );


            const raw =
                String(error.message || "");


            /*
             * Adresse invalide, montant invalide ou fonds
             * insuffisants : ce sont des erreurs de la
             * requete cliente, pas une panne serveur.
             */

            const isClientError =
                /invalide|insuffisant|insufficient|introuvable|requis|invalid|balance|debit/i
                    .test(raw);


            return res.status(isClientError ? 400 : 500).json({

                success: false,

                message:
                    raw
                    ||
                    "Erreur transaction."
            });
        }
    }
);


// =====================================================
// TRANSACTION HISTORY
// =====================================================

app.get(
    "/api/users/:id/transactions",
    (req, res) => {

        try {

            const userId =
                Number(
                    req.params.id
                );


            const transactions =
                db.prepare(`

                    SELECT *

                    FROM transactions

                    WHERE user_id = ?

                    ORDER BY id DESC

                `).all(userId);


            return res.json({

                success: true,

                transactions
            });


        } catch (error) {

            console.error(
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Erreur interne."
            });
        }
    }
);


// =====================================================
// MC MARKET : BOUTIQUE
// =====================================================

/*
 * Envoi on-chain factorise, réutilisé par
 * /api/wallet/send et /api/purchase.
 */

async function performNetworkSend(
    network,
    userId,
    to,
    amount
) {

    const userWallet =
        getUserWallet(userId, network);

    if (
        network === "ethereum"
        ||
        network === "polygon"
    ) {
        return await sendEVM(
            network,
            userWallet,
            to,
            amount
        );
    }

    if (network === "solana") {
        return await sendSolana(
            userWallet,
            to,
            amount
        );
    }

    if (network === "tron") {
        return await sendTron(
            userWallet,
            to,
            amount
        );
    }

    if (network === "bitcoin") {
        return await sendBitcoin(
            userWallet,
            to,
            amount
        );
    }

    throw new Error(
        network + " : envoi non supporté."
    );
}


/*
 * GET /api/products
 * Articles en vente (public).
 */

app.get(
    "/api/products",
    (req, res) => {

        try {

            const products =
                db.prepare(`

                    SELECT *
                    FROM products
                    WHERE active = 1
                    ORDER BY id DESC

                `).all();

            return res.json({
                success: true,
                products
            });

        } catch (error) {

            console.error("PRODUCTS ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * POST /api/admin/verify
 * Vérifie le mot de passe admin.
 */

app.post(
    "/api/admin/verify",
    async (req, res) => {

        try {

            const admin =
                await verifyAdmin(
                    req.body.userId,
                    req.body.password
                );

            if (!admin) {

                return res.status(403).json({
                    success: false,
                    message: "Accès refusé."
                });
            }

            return res.json({
                success: true,
                message: "Admin validé."
            });

        } catch (error) {

            console.error("ADMIN VERIFY ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * POST /api/admin/products
 * - { userId, password }                       => liste
 * - { userId, password, ...champs }            => création
 * - { userId, password, productId, ...champs } => mise à jour
 */

app.post(
    "/api/admin/products",
    async (req, res) => {

        try {

            const admin =
                await verifyAdmin(
                    req.body.userId,
                    req.body.password
                );

            if (!admin) {

                return res.status(403).json({
                    success: false,
                    message: "Accès refusé."
                });
            }

            const {
                productId,
                name,
                description,
                price,
                currency,
                stock,
                image_url,
                active
            } = req.body;


            // -------------------------------------
            // LISTE COMPLETE
            // -------------------------------------

            if (
                productId === undefined
                &&
                name === undefined
            ) {

                const products =
                    db.prepare(`

                        SELECT *
                        FROM products
                        ORDER BY id DESC

                    `).all();

                return res.json({
                    success: true,
                    products
                });
            }


            // -------------------------------------
            // VALIDATION
            // -------------------------------------

            const cleanName =
                String(name || "").trim();

            const cleanCurrency =
                String(currency || "").trim().toUpperCase();

            const cleanPrice =
                Number(price);

            const cleanStock =
                Number(stock);

            if (!cleanName) {

                return res.status(400).json({
                    success: false,
                    message: "Le nom de l'article est requis."
                });
            }

            if (!PRODUCT_CURRENCIES[cleanCurrency]) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Devise invalide. Utilisez " +
                        Object.keys(PRODUCT_CURRENCIES)
                            .join(", ") + "."
                });
            }

            if (
                !Number.isFinite(cleanPrice)
                ||
                cleanPrice <= 0
            ) {

                return res.status(400).json({
                    success: false,
                    message: "Prix invalide."
                });
            }

            if (
                !Number.isInteger(cleanStock)
                ||
                cleanStock < 0
            ) {

                return res.status(400).json({
                    success: false,
                    message: "Stock invalide."
                });
            }

            const cleanDescription =
                String(description || "").trim();

            const cleanImage =
                String(image_url || "").trim();

            const cleanActive =
                Number(active) === 0 ? 0 : 1;

            const priceString =
                String(cleanPrice);


            // -------------------------------------
            // MISE A JOUR
            // -------------------------------------

            if (productId !== undefined) {

                const id = Number(productId);

                const existing =
                    db.prepare(
                        "SELECT id FROM products WHERE id = ?"
                    ).get(id);

                if (!existing) {

                    return res.status(404).json({
                        success: false,
                        message: "Article introuvable."
                    });
                }

                db.prepare(`

                    UPDATE products
                    SET name = ?,
                        description = ?,
                        price = ?,
                        currency = ?,
                        stock = ?,
                        image_url = ?,
                        active = ?
                    WHERE id = ?

                `).run(
                    cleanName,
                    cleanDescription,
                    priceString,
                    cleanCurrency,
                    cleanStock,
                    cleanImage,
                    cleanActive,
                    id
                );

                return res.json({
                    success: true,
                    message: "Article modifié.",
                    productId: id
                });
            }


            // -------------------------------------
            // CREATION
            // -------------------------------------

            const result =
                db.prepare(`

                    INSERT INTO products (
                        name,
                        description,
                        price,
                        currency,
                        stock,
                        image_url,
                        active
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)

                `).run(
                    cleanName,
                    cleanDescription,
                    priceString,
                    cleanCurrency,
                    cleanStock,
                    cleanImage,
                    cleanActive
                );

            return res.json({
                success: true,
                message: "Article ajouté.",
                productId: Number(result.lastInsertRowid)
            });

        } catch (error) {

            console.error("ADMIN PRODUCT SAVE ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * POST /api/admin/products/toggle
 */

app.post(
    "/api/admin/products/toggle",
    async (req, res) => {

        try {

            const admin =
                await verifyAdmin(
                    req.body.userId,
                    req.body.password
                );

            if (!admin) {

                return res.status(403).json({
                    success: false,
                    message: "Accès refusé."
                });
            }

            const id = Number(req.body.productId);

            const product =
                db.prepare(
                    "SELECT * FROM products WHERE id = ?"
                ).get(id);

            if (!product) {

                return res.status(404).json({
                    success: false,
                    message: "Article introuvable."
                });
            }

            const nextActive =
                product.active ? 0 : 1;

            db.prepare(
                "UPDATE products SET active = ? WHERE id = ?"
            ).run(nextActive, id);

            return res.json({
                success: true,
                message:
                    nextActive
                        ? "Article remis en vente."
                        : "Article retiré de la vente.",
                active: nextActive
            });

        } catch (error) {

            console.error("ADMIN PRODUCT TOGGLE ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * POST /api/admin/products/delete
 */

app.post(
    "/api/admin/products/delete",
    async (req, res) => {

        try {

            const admin =
                await verifyAdmin(
                    req.body.userId,
                    req.body.password
                );

            if (!admin) {

                return res.status(403).json({
                    success: false,
                    message: "Accès refusé."
                });
            }

            const id = Number(req.body.productId);

            const result =
                db.prepare(
                    "DELETE FROM products WHERE id = ?"
                ).run(id);

            if (result.changes === 0) {

                return res.status(404).json({
                    success: false,
                    message: "Article introuvable."
                });
            }

            return res.json({
                success: true,
                message: "Article supprimé."
            });

        } catch (error) {

            console.error("ADMIN PRODUCT DELETE ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * POST /api/admin/orders
 */

app.post(
    "/api/admin/orders",
    async (req, res) => {

        try {

            const admin =
                await verifyAdmin(
                    req.body.userId,
                    req.body.password
                );

            if (!admin) {

                return res.status(403).json({
                    success: false,
                    message: "Accès refusé."
                });
            }

            const orders =
                db.prepare(`

                    SELECT
                        orders.*,
                        users.username AS username
                    FROM orders
                    LEFT JOIN users
                        ON users.id = orders.user_id
                    ORDER BY orders.id DESC

                `).all();

            return res.json({
                success: true,
                orders
            });

        } catch (error) {

            console.error("ADMIN ORDERS ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * GET /api/users/:id/balances
 * Soldes on-chain par réseau (market.js).
 */

app.get(
    "/api/users/:id/balances",
    async (req, res) => {

        try {

            const userId = Number(req.params.id);

            if (!Number.isInteger(userId)) {

                return res.status(400).json({
                    success: false,
                    message: "ID invalide."
                });
            }

            const networks =
                SUPPORTED_WALLET_NETWORKS.slice();

            const balances = {};

            for (const network of networks) {

                const wallet =
                    db.prepare(`

                        SELECT address
                        FROM wallets
                        WHERE user_id = ?
                        AND network = ?

                    `).get(userId, network);

                if (!wallet) {
                    continue;
                }

                let balance = null;

                try {

                    balance =
                        await fetchBalance(
                            network,
                            wallet.address
                        );

                } catch (err) {

                    console.error(
                        "BALANCE " + network + " ERROR:",
                        err.message
                    );
                }

                balances[network] = {
                    address: wallet.address,
                    symbol: NETWORK_SYMBOLS[network] || network,
                    balance: balance === null ? 0 : balance,
                    available: balance !== null
                };
            }

            return res.json({
                success: true,
                balances
            });

        } catch (error) {

            console.error("BALANCES ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * GET /api/wallet  => compat walletserver.js
 * GET /api/wallet/:coin/address
 */

app.get(
    "/api/wallet",
    async (req, res) => {

        try {

            const userId =
                Number(
                    (req.query && req.query.userId)
                    ||
                    (req.body && req.body.userId)
                );

            if (!Number.isInteger(userId)) {

                return res.status(401).json({
                    success: false,
                    message: "Utilisateur non identifié."
                });
            }

            const user =
                db.prepare(
                    "SELECT * FROM users WHERE id = ?"
                ).get(userId);

            if (!user) {

                return res.status(401).json({
                    success: false,
                    message: "Utilisateur non identifié."
                });
            }

            const rows =
                db.prepare(`

                    SELECT network, address
                    FROM wallets
                    WHERE user_id = ?

                `).all(userId);

            const wallets = {};
            const balances = {};

            for (const row of rows) {

                // les anciens réseaux retirés sont ignorés

                if (
                    !SUPPORTED_WALLET_NETWORKS.includes(
                        row.network
                    )
                ) {
                    continue;
                }


                const symbol =
                    NETWORK_SYMBOLS[row.network]
                    || row.network.toUpperCase();

                wallets[symbol] = {
                    address: row.address
                };

                try {

                    const value =
                        await fetchBalance(
                            row.network,
                            row.address
                        );

                    balances[symbol] =
                        value === null ? 0 : value;

                } catch (err) {

                    balances[symbol] = 0;
                }
            }

            return res.json({
                success: true,
                username: user.username,
                wallets,
                balances
            });

        } catch (error) {

            console.error("WALLET ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


app.get(
    "/api/wallet/:coin/address",
    (req, res) => {

        try {

            const userId = Number(req.query.userId);

            if (!Number.isInteger(userId)) {

                return res.status(401).json({
                    success: false,
                    message: "Utilisateur non identifié."
                });
            }

            const coin =
                String(req.params.coin || "").toUpperCase();

            const network =
                PRODUCT_CURRENCIES[coin]
                ||
                Object.keys(NETWORK_SYMBOLS)
                    .find(
                        key => NETWORK_SYMBOLS[key] === coin
                    );

            if (!network) {

                return res.status(400).json({
                    success: false,
                    message: "Devise inconnue."
                });
            }

            if (
                !SUPPORTED_WALLET_NETWORKS.includes(network)
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Devise non supportée. " +
                        "Utilisez ETH ou BTC."
                });
            }

            const wallet =
                db.prepare(`

                    SELECT address
                    FROM wallets
                    WHERE user_id = ?
                    AND network = ?

                `).get(userId, network);

            if (!wallet) {

                return res.status(404).json({
                    success: false,
                    message: "Adresse introuvable."
                });
            }

            return res.json({
                success: true,
                coin,
                address: wallet.address
            });

        } catch (error) {

            console.error("WALLET ADDRESS ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * POST /api/purchase
 * Achat d'un article payé depuis le wallet du client.
 */

app.post(
    "/api/purchase",
    async (req, res) => {

        try {

            const {
                userId,
                password,
                productId,
                quantity,
                network,
                deliveryAddress
            } = req.body;


            // -------------------------------------
            // ADRESSE DE LIVRAISON
            // -------------------------------------

            const delivery =
                String(deliveryAddress || "")
                    .trim()
                    .replace(/\s+/g, " ");


            if (delivery.length < 5) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Adresse de livraison requise " +
                        "(5 caractères minimum)."
                });
            }


            if (delivery.length > 500) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Adresse de livraison trop longue " +
                        "(500 caractères maximum)."
                });
            }

            const id = Number(userId);

            if (!Number.isInteger(id)) {

                return res.status(400).json({
                    success: false,
                    message: "userId invalide."
                });
            }

            if (!password) {

                return res.status(400).json({
                    success: false,
                    message: "Mot de passe requis."
                });
            }


            // -------------------------------------
            // UTILISATEUR
            // -------------------------------------

            const user =
                db.prepare(
                    "SELECT * FROM users WHERE id = ?"
                ).get(id);

            if (!user) {

                return res.status(404).json({
                    success: false,
                    message: "Utilisateur introuvable."
                });
            }

            const valid =
                await bcrypt.compare(
                    password,
                    user.password_hash
                );

            if (!valid) {

                return res.status(401).json({
                    success: false,
                    message: "Mot de passe incorrect."
                });
            }


            // -------------------------------------
            // ARTICLE
            // -------------------------------------

            const product =
                db.prepare(
                    "SELECT * FROM products WHERE id = ?"
                ).get(Number(productId));

            if (!product) {

                return res.status(404).json({
                    success: false,
                    message: "Article introuvable."
                });
            }

            if (!product.active) {

                return res.status(400).json({
                    success: false,
                    message: "Cet article n'est plus en vente."
                });
            }


            // -------------------------------------
            // QUANTITE
            // -------------------------------------

            const qty =
                Math.floor(Number(quantity));

            if (!Number.isInteger(qty) || qty < 1) {

                return res.status(400).json({
                    success: false,
                    message: "Quantité invalide."
                });
            }

            if (qty > Number(product.stock)) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Stock insuffisant. Disponible : " +
                        product.stock + "."
                });
            }


            // -------------------------------------
            // RESEAU DE PAIEMENT
            // -------------------------------------

            const expectedNetwork =
                PRODUCT_CURRENCIES[product.currency];

            /*
             * Les devises retirées (POL, SOL, TRX, ...)
             * ne sont plus payables.
             */

            if (!expectedNetwork) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Cet article n'est plus payable : " +
                        "seules les devises ETH et BTC sont acceptées."
                });
            }

            const payNetwork =
                String(
                    network || expectedNetwork
                ).toLowerCase();

            if (payNetwork !== expectedNetwork) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Cet article se paie uniquement en " +
                        product.currency + "."
                });
            }


            // -------------------------------------
            // ADRESSE BOUTIQUE
            // -------------------------------------

            const storeAddress =
                getStoreAddress(payNetwork);

            if (!storeAddress) {

                return res.status(500).json({
                    success: false,
                    message:
                        "Adresse boutique indisponible pour " +
                        payNetwork + ". Configurez " +
                        "STORE_ADDRESS_" +
                        payNetwork.toUpperCase() + " dans le .env."
                });
            }


            // -------------------------------------
            // MONTANT
            // -------------------------------------

            const total =
                qty * Number(product.price);

            if (!Number.isFinite(total) || total <= 0) {

                return res.status(400).json({
                    success: false,
                    message: "Montant total invalide."
                });
            }


            // -------------------------------------
            // VERIFICATION DU SOLDE CLIENT
            // -------------------------------------

            const buyerWallet =
                db.prepare(`

                    SELECT address
                    FROM wallets
                    WHERE user_id = ?
                    AND network = ?

                `).get(id, payNetwork);

            if (buyerWallet && buyerWallet.address) {

                let available = null;

                try {

                    available =
                        await fetchBalance(
                            payNetwork,
                            buyerWallet.address
                        );

                } catch (balanceError) {

                    console.error(
                        "PURCHASE BALANCE ERROR:",
                        balanceError.message
                    );
                }

                // solde connu et insuffisant : refus propre,
                // sans lancer de transaction on-chain
                if (
                    available !== null
                    &&
                    available < total
                ) {

                    const symbol =
                        NETWORK_SYMBOLS[payNetwork] || payNetwork;

                    return res.status(400).json({
                        success: false,
                        message:
                            "Solde insuffisant. Disponible : " +
                            available + " " + symbol +
                            ", requis : " + total + " " + symbol +
                            " (hors frais de réseau)."
                    });
                }
            }


            // -------------------------------------
            // PAIEMENT ON-CHAIN
            // -------------------------------------

            let result;

            try {

                result =
                    await performNetworkSend(
                        payNetwork,
                        id,
                        storeAddress,
                        String(total)
                    );

            } catch (sendError) {

                console.error(
                    "PURCHASE SEND ERROR:",
                    sendError
                );

                const raw =
                    String(sendError.message || "");

                // on ne renvoie jamais la trace brute du RPC au client
                const isFunds =
                    /insufficient|simulation failed|balance|debit/i
                        .test(raw);

                return res.status(400).json({
                    success: false,
                    message: isFunds
                        ?
                        "Paiement refusé : fonds insuffisants pour " +
                        "couvrir le montant et les frais de réseau."
                        :
                        "Paiement refusé : la transaction n'a pas pu " +
                        "être signée ou envoyée."
                });
            }


            // -------------------------------------
            // ENREGISTREMENT
            // -------------------------------------

            const orderResult =
                db.prepare(`

                    INSERT INTO orders (
                        user_id,
                        product_id,
                        product_name,
                        quantity,
                        unit_price,
                        currency,
                        total,
                        payment_network,
                        tx_hash,
                        from_address,
                        to_address,
                        status,
                        delivery_address
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

                `).run(
                    id,
                    product.id,
                    product.name,
                    qty,
                    String(product.price),
                    product.currency,
                    String(total),
                    payNetwork,
                    result.hash,
                    result.from,
                    result.to,
                    "paid",
                    delivery
                );


            db.prepare(`

                INSERT INTO transactions (
                    user_id,
                    network,
                    tx_hash,
                    from_address,
                    to_address,
                    amount,
                    status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)

            `).run(
                id,
                payNetwork,
                result.hash,
                result.from,
                result.to,
                String(total),
                "confirmed"
            );


            db.prepare(
                "UPDATE products SET stock = stock - ? WHERE id = ?"
            ).run(qty, product.id);


            // -------------------------------------
            // REPONSE
            // -------------------------------------

            return res.json({
                success: true,
                message: "Achat confirmé.",
                order: {
                    id: Number(orderResult.lastInsertRowid),
                    product_id: product.id,
                    product_name: product.name,
                    quantity: qty,
                    unit_price: String(product.price),
                    currency: product.currency,
                    total: String(total),
                    payment_network: payNetwork,
                    tx_hash: result.hash,
                    from_address: result.from,
                    to_address: result.to,
                    status: "paid",
                    delivery_address: delivery
                }
            });

        } catch (error) {

            console.error("PURCHASE ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


/*
 * POST /api/checkout
 * Commande multi-articles (panier) payée depuis le wallet.
 *
 * Le panier peut contenir plusieurs articles, y compris dans
 * des devises différentes : un paiement on-chain est effectué
 * par devise (donc par réseau).
 *
 * Tous les contrôles (article, stock, adresse boutique, solde)
 * sont faits AVANT le premier envoi, pour éviter un débit
 * partiel quand une ligne du panier est invalide.
 */

const MAX_CART_LINES = 20;

const MAX_CART_QUANTITY = 1000;


/*
 * Arrondi au 1e-8 près (précision BTC) pour éviter
 * les artefacts de calcul flottant sur les totaux.
 */

function normalizeAmount(value) {

    const amount = Number(value);

    if (!Number.isFinite(amount)) {
        return amount;
    }

    return Math.round(amount * 1e8) / 1e8;
}


app.post(
    "/api/checkout",
    async (req, res) => {

        try {

            const {
                userId,
                password,
                deliveryAddress,
                items
            } = req.body;


            // -------------------------------------
            // ADRESSE DE LIVRAISON
            // -------------------------------------

            const delivery =
                String(deliveryAddress || "")
                    .trim()
                    .replace(/\s+/g, " ");

            if (delivery.length < 5) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Adresse de livraison requise " +
                        "(5 caractères minimum)."
                });
            }

            if (delivery.length > 500) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Adresse de livraison trop longue " +
                        "(500 caractères maximum)."
                });
            }


            // -------------------------------------
            // PANIER (structure)
            // -------------------------------------

            if (!Array.isArray(items) || items.length === 0) {

                return res.status(400).json({
                    success: false,
                    message: "Votre panier est vide."
                });
            }

            if (items.length > MAX_CART_LINES) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Panier trop volumineux (" +
                        MAX_CART_LINES + " articles maximum)."
                });
            }

            /*
             * Les lignes en double sur un même article sont
             * fusionnées : le stock et le total restent justes.
             */

            const quantities = new Map();

            for (const raw of items) {

                const productId =
                    Number(raw && raw.productId);

                const qty =
                    Math.floor(Number(raw && raw.quantity));

                if (
                    !Number.isInteger(productId)
                    || productId <= 0
                ) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Article invalide dans le panier."
                    });
                }

                if (
                    !Number.isInteger(qty)
                    || qty < 1
                    || qty > MAX_CART_QUANTITY
                ) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Quantité invalide pour l'article " +
                            productId + "."
                    });
                }

                const already =
                    quantities.get(productId) || 0;

                if (already + qty > MAX_CART_QUANTITY) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Quantité trop élevée pour l'article " +
                            productId + "."
                    });
                }

                quantities.set(productId, already + qty);
            }


            // -------------------------------------
            // UTILISATEUR
            // -------------------------------------

            const id = Number(userId);

            if (!Number.isInteger(id)) {

                return res.status(400).json({
                    success: false,
                    message: "userId invalide."
                });
            }

            if (!password) {

                return res.status(400).json({
                    success: false,
                    message: "Mot de passe requis."
                });
            }

            const user =
                db.prepare(
                    "SELECT * FROM users WHERE id = ?"
                ).get(id);

            if (!user) {

                return res.status(404).json({
                    success: false,
                    message: "Utilisateur introuvable."
                });
            }

            const valid =
                await bcrypt.compare(
                    password,
                    user.password_hash
                );

            if (!valid) {

                return res.status(401).json({
                    success: false,
                    message: "Mot de passe incorrect."
                });
            }


            // -------------------------------------
            // ARTICLES + STOCK + GROUPES PAR RESEAU
            // -------------------------------------

            const groups = new Map();

            for (const [productId, qty] of quantities) {

                const product =
                    db.prepare(
                        "SELECT * FROM products WHERE id = ?"
                    ).get(productId);

                if (!product) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Article introuvable dans le panier " +
                            "(référence " + productId + ")."
                    });
                }

                if (!product.active) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "L'article \"" + product.name +
                            "\" n'est plus en vente."
                    });
                }

                if (qty > Number(product.stock)) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Stock insuffisant pour \"" +
                            product.name + "\". Disponible : " +
                            product.stock + "."
                    });
                }

                const network =
                    PRODUCT_CURRENCIES[product.currency];

                if (!network) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "\"" + product.name + "\" n'est plus " +
                            "payable : seules les devises ETH et BTC " +
                            "sont acceptées."
                    });
                }

                if (!getStoreAddress(network)) {

                    return res.status(500).json({
                        success: false,
                        message:
                            "Adresse boutique indisponible pour " +
                            network + ". Configurez " +
                            "STORE_ADDRESS_" +
                            network.toUpperCase() +
                            " dans le .env."
                    });
                }

                const lineTotal =
                    normalizeAmount(qty * Number(product.price));

                if (!Number.isFinite(lineTotal) || lineTotal <= 0) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Prix invalide pour \"" +
                            product.name + "\"."
                    });
                }

                const group = groups.get(network) || {
                    network,
                    currency: product.currency,
                    total: 0,
                    lines: []
                };

                group.total =
                    normalizeAmount(group.total + lineTotal);

                group.lines.push({
                    product,
                    qty,
                    lineTotal: String(lineTotal)
                });

                groups.set(network, group);
            }


            // -------------------------------------
            // SOLDE CLIENT (tous les reseaux, avant envoi)
            // -------------------------------------

            for (const group of groups.values()) {

                const buyerWallet =
                    db.prepare(`

                        SELECT address
                        FROM wallets
                        WHERE user_id = ?
                        AND network = ?

                    `).get(id, group.network);

                if (!buyerWallet || !buyerWallet.address) {
                    continue;
                }

                let available = null;

                try {

                    available =
                        await fetchBalance(
                            group.network,
                            buyerWallet.address
                        );

                } catch (balanceError) {

                    console.error(
                        "CHECKOUT BALANCE ERROR:",
                        balanceError.message
                    );
                }

                if (
                    available !== null
                    &&
                    available < group.total
                ) {

                    const symbol =
                        NETWORK_SYMBOLS[group.network]
                        || group.currency;

                    return res.status(400).json({
                        success: false,
                        message:
                            "Solde insuffisant en " + symbol +
                            ". Disponible : " + available +
                            " " + symbol + ", requis : " +
                            group.total + " " + symbol +
                            " (hors frais de réseau)."
                    });
                }
            }


            // -------------------------------------
            // PAIEMENT PAR RESEAU + ENREGISTREMENT
            // -------------------------------------

            const paid = [];

            const failures = [];

            const paidProductIds = [];

            const failedProductIds = [];

            for (const group of groups.values()) {

                const storeAddress =
                    getStoreAddress(group.network);

                let result;

                try {

                    result =
                        await performNetworkSend(
                            group.network,
                            id,
                            storeAddress,
                            String(group.total)
                        );

                } catch (sendError) {

                    console.error(
                        "CHECKOUT SEND ERROR:",
                        sendError
                    );

                    const raw =
                        String(sendError.message || "");

                    const isFunds =
                        /insufficient|simulation failed|balance|debit/i
                            .test(raw);

                    failures.push({
                        network: group.network,
                        currency: group.currency,
                        total: String(group.total),
                        message: isFunds
                            ?
                            "Paiement refusé en " + group.currency +
                            " : fonds insuffisants pour couvrir " +
                            "le montant et les frais de réseau."
                            :
                            "Paiement refusé en " + group.currency +
                            " : la transaction n'a pas pu être " +
                            "signée ou envoyée."
                    });

                    for (const line of group.lines) {
                        failedProductIds.push(line.product.id);
                    }

                    continue;
                }

                /*
                 * Les écritures d'un même paiement sont
                 * regroupées : soit tout passe, soit rien.
                 */

                const storeGroup =
                    db.transaction(() => {

                        const orderIds = [];

                        for (const line of group.lines) {

                            const orderResult =
                                db.prepare(`

                                    INSERT INTO orders (
                                        user_id,
                                        product_id,
                                        product_name,
                                        quantity,
                                        unit_price,
                                        currency,
                                        total,
                                        payment_network,
                                        tx_hash,
                                        from_address,
                                        to_address,
                                        status,
                                        delivery_address
                                    )
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

                                `).run(
                                    id,
                                    line.product.id,
                                    line.product.name,
                                    line.qty,
                                    String(line.product.price),
                                    line.product.currency,
                                    line.lineTotal,
                                    group.network,
                                    result.hash,
                                    result.from,
                                    result.to,
                                    "paid",
                                    delivery
                                );

                            orderIds.push(
                                Number(orderResult.lastInsertRowid)
                            );

                            db.prepare(
                                "UPDATE products SET stock = stock - ? " +
                                "WHERE id = ?"
                            ).run(line.qty, line.product.id);
                        }

                        /*
                         * Un seul mouvement de transaction
                         * par paiement on-chain (tx_hash unique).
                         */

                        db.prepare(`

                            INSERT INTO transactions (
                                user_id,
                                network,
                                tx_hash,
                                from_address,
                                to_address,
                                amount,
                                status
                            )
                            VALUES (?, ?, ?, ?, ?, ?, ?)

                        `).run(
                            id,
                            group.network,
                            result.hash,
                            result.from,
                            result.to,
                            String(group.total),
                            "confirmed"
                        );

                        return orderIds;
                    });

                let orderIds;

                try {

                    orderIds = storeGroup();

                } catch (dbError) {

                    console.error(
                        "CHECKOUT DB ERROR:",
                        dbError
                    );

                    failures.push({
                        network: group.network,
                        currency: group.currency,
                        total: String(group.total),
                        tx_hash: result.hash,
                        message:
                            "Paiement envoyé en " + group.currency +
                            " (tx " + result.hash + ") mais " +
                            "l'enregistrement de la commande a " +
                            "échoué. Conservez ce hash et contactez " +
                            "le support."
                    });

                    for (const line of group.lines) {
                        failedProductIds.push(line.product.id);
                    }

                    continue;
                }

                for (const line of group.lines) {
                    paidProductIds.push(line.product.id);
                }

                paid.push({
                    network: group.network,
                    currency: group.currency,
                    total: String(group.total),
                    tx_hash: result.hash,
                    from_address: result.from,
                    to_address: result.to,
                    order_ids: orderIds,
                    items: group.lines.map(line => ({
                        product_id: line.product.id,
                        product_name: line.product.name,
                        quantity: line.qty,
                        unit_price: String(line.product.price),
                        total: line.lineTotal
                    }))
                });
            }


            // -------------------------------------
            // REPONSE
            // -------------------------------------

            if (paid.length === 0) {

                return res.status(400).json({
                    success: false,
                    message: failures.length
                        ? failures[0].message
                        : "Paiement refusé : aucune transaction " +
                          "n'a abouti.",
                    failures
                });
            }

            return res.json({
                success: true,
                message: failures.length
                    ? "Commande partiellement payée."
                    : "Commande confirmée.",
                delivery_address: delivery,
                paid,
                failures,
                paid_product_ids: paidProductIds,
                failed_product_ids: failedProductIds
            });

        } catch (error) {

            console.error("CHECKOUT ERROR:", error);

            return res.status(500).json({
                success: false,
                message: "Erreur interne."
            });
        }
    }
);


// =====================================================
// HOMEPAGE
// =====================================================

app.get(
    "/",
    (req, res) => {

        res.sendFile(

            path.join(

                __dirname,

                "public",

                "homepage.html"
            )
        );
    }
);


// =====================================================
// SERVER
// =====================================================

app.listen(

    PORT,

    () => {

        console.log(
            `Serveur démarré sur http://localhost:${PORT}`
        );

        console.log(
            "Réseaux wallet : Ethereum (ETH) / Bitcoin (BTC)"
        );
    }
);