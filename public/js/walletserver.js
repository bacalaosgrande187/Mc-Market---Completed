/*
public/js/walletserver.js

```
IMPORTANT:
Ce fichier est exécuté dans le navigateur.

Il ne contient :
- aucun mnemonic
- aucune private key

Le serveur doit fournir les adresses via :
    GET /api/wallets
```

*/

let wallets = {};
let selectedCoin = null;

/*
    Mapping devise affichée -> réseau serveur.
    Doit rester aligné avec PRODUCT_CURRENCIES
    dans server.js.

    Seuls Ethereum et Bitcoin sont supportés.
*/
const COIN_NETWORKS = {

    BTC: "bitcoin",

    ETH: "ethereum"

};

/*
    Récupère la session Mc Market
    (localStorage, posée par login.js).
*/
function getCurrentUser() {

    try {

        return JSON.parse(
            localStorage.getItem("user") || "null"
        );

    } catch (error) {

        return null;

    }

}

// ======================================================
// INITIALISATION
// ======================================================

document.addEventListener("DOMContentLoaded", async () => {


await loadWallet();

setupLogout();

setupSendForm();


});

// ======================================================
// CHARGER LE WALLET DU CLIENT
// ======================================================

async function loadWallet() {


try {

    const currentUser = getCurrentUser();

    if (!currentUser || !currentUser.id) {

        window.location.href = "/login.html";

        return;
    }

    const response = await fetch(
        `/api/wallet?userId=${encodeURIComponent(currentUser.id)}`,
        {
            method: "GET",
            credentials: "include"
        }
    );

    if (response.status === 401) {

        window.location.href = "/login.html";

        return;
    }

    if (!response.ok) {

        throw new Error("Impossible de charger le wallet");

    }

    const data = await response.json();

    /*
        Exemple attendu :

        {
            username: "wayne#1324",

            wallets: {
                BTC: {
                    address: "bc1..."
                },

                ETH: {
                    address: "0x..."
                }
            }
        }
    */

    wallets = data.wallets || {};

    // Nom du client
    const usernameElement =
        document.getElementById("username");

    if (usernameElement && data.username) {

        usernameElement.textContent =
            data.username;

    }

    // Afficher les balances + leur état (confirmed/unavailable/error)
    updateBalances(
        data.balances || {},
        data.balanceStates || {}
    );


} catch (error) {

    console.error(
        "Wallet error:",
        error
    );

}


}

// ======================================================
// BALANCES
// ======================================================

/*
    balances      : { BTC: 0.123, ... }
    balanceStates : { BTC: { status: "confirmed"|"unavailable"|"error" } }

    Un solde indisponible (RPC en échec) ne doit jamais être
    affiché comme un vrai 0 : on affiche "N/A".
*/
function updateBalances(balances, balanceStates) {

balanceStates = balanceStates || {};


const balanceMap = {

    BTC: "btc-balance",
    ETH: "eth-balance"

};


for (const coin in balanceMap) {

    const element =
        document.getElementById(
            balanceMap[coin]
        );

    if (!element) {
        continue;
    }

    const state =
        balanceStates[coin] || {};

    const status =
        state.status
        || (balances[coin] === undefined
            ? "unknown"
            : "confirmed");

    const value =
        balances[coin];

    if (
        status !== "confirmed"
        || value === null
        || value === undefined
    ) {

        element.textContent = "N/A";

        element.classList.add("balance-unknown");

        element.title = status === "error"
            ? "Solde indisponible (erreur RPC)"
            : "Solde indisponible (réseau non interrogé)";

        continue;
    }

    element.textContent =
        Number(value).toFixed(8);

    element.classList.remove("balance-unknown");

    element.title = "";

}


}

// ======================================================
// RECEIVE
// ======================================================

async function openReceive(coin) {


selectedCoin = coin;

const modal =
    document.getElementById("receiveModal");

const coinElement =
    document.getElementById("receiveCoin");

const addressElement =
    document.getElementById("receiveAddress");

const qrElement =
    document.getElementById("qrcode");


if (!modal ||
    !coinElement ||
    !addressElement ||
    !qrElement) {

    return;
}


coinElement.textContent = coin;


/*
    Cherche l'adresse déjà chargée.
*/

let wallet = wallets[coin];


/*
    Si elle n'est pas encore disponible,
    on demande directement au serveur.
*/

if (!wallet || !wallet.address) {

    try {

        const currentUser = getCurrentUser();

        const response = await fetch(
            `/api/wallet/${encodeURIComponent(coin)}/address`
            + `?userId=${encodeURIComponent(currentUser ? currentUser.id : "")}`,
            {
                method: "GET",
                credentials: "include"
            }
        );


        if (!response.ok) {

            throw new Error(
                "Adresse indisponible"
            );

        }


        wallet =
            await response.json();


        wallets[coin] = wallet;


    } catch (error) {

        console.error(error);

        addressElement.value =
            "Address unavailable";

        qrElement.innerHTML = "";

        modal.style.display = "flex";

        return;
    }

}


const address =
    wallet.address;


addressElement.value =
    address;


/*
    Génération du QR code.

    On utilise QRCode.js depuis le CDN.
*/

qrElement.innerHTML = "";


if (typeof QRCode !== "undefined") {

    new QRCode(qrElement, {

        text: address,

        width: 200,

        height: 200

    });

} else {

    qrElement.innerHTML =
        "<p>QR code library unavailable</p>";

}


modal.style.display = "flex";


}

// ======================================================
// FERMER RECEIVE
// ======================================================

function closeReceive() {

const modal =
    document.getElementById("receiveModal");

if (modal) {

    modal.style.display = "none";

}


}

// ======================================================
// COPY ADDRESS
// ======================================================

async function copyAddress() {


const input =
    document.getElementById("receiveAddress");


if (!input || !input.value) {

    return;

}


try {

    await navigator.clipboard.writeText(
        input.value
    );

    alert("Address copied!");

} catch (error) {

    input.select();

    document.execCommand("copy");

    alert("Address copied!");

}


}

// ======================================================
// SEND
// ======================================================

function openSend(coin) {


selectedCoin = coin;

const modal =
    document.getElementById("sendModal");

const coinElement =
    document.getElementById("sendCoin");


if (!modal) {

    return;

}


if (coinElement) {

    coinElement.textContent =
        coin;

}


/*
    Nettoyer le formulaire
*/

const address =
    document.getElementById(
        "destinationAddress"
    );

const amount =
    document.getElementById(
        "sendAmount"
    );


if (address) {

    address.value = "";

}


if (amount) {

    amount.value = "";

}


const netElement =
    document.getElementById(
        "sendNetAmount"
    );

if (netElement) {

    netElement.textContent =
        "0.00000000";

}


modal.style.display = "flex";


}

// ======================================================
// FERMER SEND
// ======================================================

function closeSend() {


const modal =
    document.getElementById("sendModal");

if (modal) {

    modal.style.display = "none";

}


}

// ======================================================
// FORMULAIRE SEND
// ======================================================

function setupSendForm() {


const form =
    document.getElementById("sendForm");


if (!form) {

    return;

}


/*
    Aperçu du montant reçu par le destinataire.
    Taxe de 15% : le destinataire reçoit 85%
    du montant saisi.
*/

const amountInput =
    document.getElementById("sendAmount");

if (amountInput) {

    amountInput.addEventListener(
        "input",
        updateNetPreview
    );

}


form.addEventListener(
    "submit",
    async (event) => {

        event.preventDefault();


        const destination =
            document.getElementById(
                "destinationAddress"
            ).value.trim();


        const amount =
            document.getElementById(
                "sendAmount"
            ).value;


        if (!selectedCoin) {

            alert("Select a cryptocurrency.");

            return;

        }


        if (!destination) {

            alert(
                "Enter a destination address."
            );

            return;

        }


        if (!amount ||
            Number(amount) <= 0) {

            alert(
                "Enter a valid amount."
            );

            return;

        }


        /*
            L'envoi est signé côté serveur à partir
            du mnemonic du wallet : aucune clé privée
            ne transite dans le navigateur.
        */

        const currentUser = getCurrentUser();

        if (!currentUser || !currentUser.id) {

            window.location.href = "/login.html";

            return;
        }

        const network = COIN_NETWORKS[selectedCoin];

        if (!network) {

            alert(
                "Réseau non supporté pour "
                + selectedCoin
            );

            return;
        }

        let password = "";

        const passwordField =
            document.getElementById("sendPassword");

        if (passwordField) {

            password = passwordField.value;

        } else {

            password = window.prompt(
                "Confirmez votre mot de passe pour signer la transaction :"
            ) || "";

        }

        if (!password) {

            alert("Mot de passe requis.");

            return;
        }

        try {

            const response = await fetch(
                "/api/wallet/send",
                {

                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    credentials: "include",

                    body: JSON.stringify({

                        userId:
                            currentUser.id,

                        password:
                            password,

                        network:
                            network,

                        to:
                            destination,

                        amount:
                            amount

                    })

                }
            );


            const result =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    result.message ||
                    result.error ||
                    "Transaction refusée."
                );

            }


            alert(
                "Transaction envoyée."
            );


            closeSend();


            /*
                Recharge les balances
            */

            await loadWallet();


        } catch (error) {

            console.error(error);

            alert(
                error.message
            );

        }

    }
);


}

// ======================================================
// APERÇU DU MONTANT REÇU (TAXE 15%)
// ======================================================

function updateNetPreview() {


const amountInput =
    document.getElementById("sendAmount");

const netElement =
    document.getElementById("sendNetAmount");


if (!amountInput || !netElement) {

    return;

}


const value = Number(amountInput.value);


if (!Number.isFinite(value) || value <= 0) {

    netElement.textContent =
        "0.00000000";

    return;

}


/*
    Le destinataire reçoit 85% du montant
    (15% partent à l'adresse de collecte).
*/

const net = value * 0.85;


netElement.textContent =
    net.toFixed(8);


}

// ======================================================
// LOGOUT
// ======================================================

function setupLogout() {


const button =
    document.getElementById(
        "logoutBtn"
    );


if (!button) {

    return;

}


button.addEventListener(
    "click",
    async () => {

        try {

            await fetch(
                "/logout",
                {
                    method: "POST",
                    credentials: "include"
                }
            );

        } finally {

            localStorage.removeItem("user");

            window.location.href =
                "/login.html";

        }

    }
);


}

// ======================================================
// FERMER LES MODALS EN CLIQUANT À L'EXTÉRIEUR
// ======================================================

window.addEventListener(
"click",
(event) => {


    const receiveModal =
        document.getElementById(
            "receiveModal"
        );

    const sendModal =
        document.getElementById(
            "sendModal"
        );


    if (event.target === receiveModal) {

        closeReceive();

    }


    if (event.target === sendModal) {

        closeSend();

    }

}


);
