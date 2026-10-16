/*
 * public/js/market.js
 *
 * Boutique Mc Market côté client.
 * - Charge les articles en vente
 * - Affiche les balances du wallet
 * - Achat avec les fonds du wallet (paiement on-chain)
 */

let currentUser = null;
let products = [];

/*
 * Seules deux devises restent acceptées : ETH et BTC.
 */

const NETWORK_LABELS = {
    ethereum: "Ethereum (ETH)",
    bitcoin: "Bitcoin (BTC)"
};

const CURRENCY_TO_NETWORK = {
    ETH: "ethereum",
    BTC: "bitcoin"
};

const MIN_DELIVERY_LENGTH = 5;

// ======================================================
// INITIALISATION
// ======================================================

document.addEventListener("DOMContentLoaded", async () => {

    currentUser =
        JSON.parse(
            localStorage.getItem("user") || "null"
        );

    if (!currentUser || !currentUser.id) {
        window.location.href = "/login.html";
        return;
    }

    if (currentUser.role === "admin") {
        document.getElementById("adminLink").style.display = "";
    }

    setupLogout();

    setupCart();

    const quantityInput =
        document.getElementById("buyQuantity");

    if (quantityInput) {

        quantityInput.addEventListener(
            "input",
            updateBuyTotal
        );
    }

    await Promise.all([
        loadProducts(),
        loadBalances()
    ]);

    /*
     * Le stock et les articles ont pu changer depuis la
     * dernière visite : on recale le panier enregistré
     * sur ce qui est réellement en vente.
     */

    reconcileCart();

    renderCart();
});

// ======================================================
// DECONNEXION
// ======================================================

function setupLogout() {

    const btn = document.getElementById("logoutBtn");

    if (!btn) return;

    btn.addEventListener("click", () => {
        localStorage.removeItem("user");
        window.location.href = "/login.html";
    });
}

// ======================================================
// ARTICLES EN VENTE
// ======================================================

async function loadProducts() {

    const grid =
        document.getElementById("productsGrid");

    try {

        const response =
            await fetch("/api/products");

        const data = await response.json();

        products = data.products || [];

        productsLoaded = true;

        if (products.length === 0) {
            grid.innerHTML =
                "<span>Aucun article en vente pour le moment.</span>";
            return;
        }

        grid.innerHTML = "";

        for (const product of products) {
            grid.appendChild(
                createProductCard(product)
            );
        }

    } catch (error) {

        console.error(error);

        grid.innerHTML =
            "<span>Impossible de charger les articles.</span>";
    }
}

function createProductCard(product) {

    const card = document.createElement("div");
    card.className = "product-card mc-panel";

    const outOfStock =
        Number(product.stock) <= 0;

    const imageUrl =
        String(product.image_url || "").trim();

    card.innerHTML = `
        <div class="product-image-wrap">
            <img class="product-image" alt="">
        </div>
        <h3></h3>
        <p class="desc"></p>
        <div class="product-price">
            ${product.price} <small>${product.currency}</small>
        </div>
        <div class="product-stock ${outOfStock ? "out" : ""}">
            ${outOfStock
                ? "Rupture de stock"
                : "Stock : " + product.stock}
        </div>
        <div class="product-actions">
            <button class="buy-button" ${outOfStock ? "disabled" : ""}>
                Acheter
            </button>
            <button class="cart-button" ${outOfStock ? "disabled" : ""}>
                Ajouter au panier
            </button>
        </div>
    `;

    const image = card.querySelector(".product-image");

    image.src =
        imageUrl || "/images/mc-market-logo.png";
    image.alt = product.name || "Article";

    image.addEventListener("error", () => {
        if (image.src.indexOf("/images/mc-market-logo.png") === -1) {
            image.src = "/images/mc-market-logo.png";
        }
    });

    card.querySelector("h3").textContent = product.name;
    card.querySelector(".desc").textContent =
        product.description || "";

    card.querySelector(".buy-button").addEventListener(
        "click",
        () => openBuyModal(product)
    );

    card.querySelector(".cart-button").addEventListener(
        "click",
        () => addToCart(product, 1)
    );

    return card;
}

// ======================================================
// BALANCES DU WALLET
// ======================================================

async function loadBalances() {

    const strip =
        document.getElementById("walletStrip");

    try {

        const response = await fetch(
            `/api/users/${currentUser.id}/balances`
        );

        const data = await response.json();

        const balances = data.balances || {};

        const entries = Object.entries(balances);

        if (entries.length === 0) {

            strip.innerHTML =
                "<span class='balance-chip'>" +
                "Balances indisponibles (RPC non configuré)." +
                "</span>";

            return;
        }

        strip.innerHTML = "";

        for (const [network, info] of entries) {

            const chip = document.createElement("span");
            chip.className = "balance-chip";

            chip.textContent = NETWORK_LABELS[network] || network;

            const bold = document.createElement("b");
            bold.textContent =
                Number(info.balance).toFixed(6) + " " + info.symbol;

            chip.appendChild(bold);

            strip.appendChild(chip);
        }

    } catch (error) {

        console.error(error);

        strip.innerHTML =
            "<span class='balance-chip'>Balances indisponibles.</span>";
    }
}

// ======================================================
// MODALE D'ACHAT
// ======================================================

let currentProduct = null;

function openBuyModal(product) {

    currentProduct = product;

    document.getElementById("buyProductName").textContent =
        product.name + " — " + product.price + " " + product.currency;

    document.getElementById("buyQuantity").value = 1;
    document.getElementById("buyMessage").textContent = "";

    /*
     * Le paiement se fait dans la devise du produit.
     */
    const select = document.getElementById("buyNetwork");
    const network = CURRENCY_TO_NETWORK[product.currency];

    select.innerHTML = "";

    const option = document.createElement("option");
    option.value = network;
    option.textContent = NETWORK_LABELS[network] || product.currency;

    select.appendChild(option);

    if (!network) {

        document.getElementById("buyMessage").textContent =
            "Cet article n'est plus payable : " +
            "seules les devises ETH et BTC sont acceptées.";
    }

    updateBuyTotal();

    document.getElementById("buyModal").classList.add("open");
}

function updateBuyTotal() {

    if (!currentProduct) return;

    const qty =
        Math.max(
            1,
            Number(document.getElementById("buyQuantity").value) || 1
        );

    const total = qty * Number(currentProduct.price);

    document.getElementById("buyTotal").textContent =
        total + " " + currentProduct.currency;
}

function closeBuyModal() {
    document.getElementById("buyModal").classList.remove("open");
    currentProduct = null;
}

// ======================================================
// ACHAT (paiement depuis le wallet)
// ======================================================

async function confirmPurchase() {

    if (!currentProduct) return;

    const message =
        document.getElementById("buyMessage");

    const qty =
        Math.max(
            1,
            Number(document.getElementById("buyQuantity").value) || 1
        );

    const network =
        document.getElementById("buyNetwork").value;

    const deliveryAddress =
        String(
            document.getElementById("buyDelivery").value || ""
        )
            .trim()
            .replace(/\s+/g, " ");

    /*
     * L'adresse de livraison est obligatoire :
     * le serveur la refuse de toute façon, on évite
     * simplement un aller-retour inutile.
     */

    if (deliveryAddress.length < MIN_DELIVERY_LENGTH) {

        message.className = "mc-message err";
        message.textContent =
            "Adresse de livraison requise " +
            "(" + MIN_DELIVERY_LENGTH + " caractères minimum).";

        document.getElementById("buyDelivery").focus();

        return;
    }

    /*
     * Le paiement on-chain exige la confirmation
     * par mot de passe (comme pour un Send).
     */
    const password = prompt(
        "Confirmez votre mot de passe pour signer le paiement :"
    );

    if (!password) return;

    message.className = "mc-message";
    message.textContent = "Transaction en cours...";

    try {

        const response = await fetch("/api/purchase", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: currentUser.id,
                password: password,
                productId: currentProduct.id,
                quantity: qty,
                network: network,
                deliveryAddress: deliveryAddress
            })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            message.className = "mc-message err";
            message.textContent = data.message || "Achat impossible.";
            return;
        }

        message.className = "mc-message ok";
        message.textContent =
            "Achat confirmé ! Tx : " + data.order.tx_hash +
            " — livraison : " + data.order.delivery_address;

        rememberDeliveryAddress(deliveryAddress);

        await Promise.all([
            loadProducts(),
            loadBalances()
        ]);

        setTimeout(closeBuyModal, 2500);

    } catch (error) {

        console.error(error);

        message.className = "mc-message err";
        message.textContent =
            "Impossible de contacter le serveur.";
    }
}

// ======================================================
// PANIER
//
// Le panier est gardé par utilisateur dans le
// localStorage, puis recalculé à chaque affichage avec
// les prix et le stock réellement renvoyés par l'API.
// Le paiement se fait avec /api/checkout.
// ======================================================

const MAX_CART_QUANTITY = 1000;

const CART_FLASH_MS = 420;

let cart = [];

let productsLoaded = false;

let checkoutInProgress = false;

let cartInitialized = false;


/*
 * Cale le panier enregistré sur les articles réellement
 * en vente, en limitant chaque quantité au stock.
 */

function reconcileCart() {

    if (!productsLoaded) return;

    const kept = [];

    let removedCount = 0;

    let clampedCount = 0;

    for (const line of cart) {

        const product = findProduct(line.productId);

        if (!product) {
            removedCount += 1;
            continue;
        }

        const stock = Math.max(
            0,
            Math.floor(Number(product.stock) || 0)
        );

        if (stock < 1) {
            removedCount += 1;
            continue;
        }

        const limit = Math.min(MAX_CART_QUANTITY, stock);

        let quantity = Math.min(line.quantity, limit);

        if (quantity < line.quantity) {
            clampedCount += 1;
            quantity = Math.max(1, quantity);
        }

        kept.push({
            productId: Number(line.productId),
            quantity
        });
    }

    cart = kept;

    saveCart();

    if (removedCount > 0 || clampedCount > 0) {

        const parts = [];

        if (removedCount > 0) {
            parts.push(
                removedCount +
                (removedCount > 1
                    ? " articles retirés du panier"
                    : " article retiré du panier") +
                " (plus en vente)"
            );
        }

        if (clampedCount > 0) {
            parts.push(
                clampedCount +
                (clampedCount > 1
                    ? " quantités ajustées au stock"
                    : " quantité ajustée au stock")
            );
        }

        showMarketMessage(parts.join(" — ") + ".", "err");
    }
}


// ------------------------------------------------------
// MISE EN PLACE DE L'INTERFACE
// ------------------------------------------------------

function setupCart() {

    if (cartInitialized) return;

    cartInitialized = true;

    cart = loadCart();

    const cartBtn = document.getElementById("cartBtn");

    if (cartBtn) {

        cartBtn.addEventListener("click", event => {
            event.stopPropagation();
            toggleCartPanel();
        });
    }

    /*
     * Un clic en dehors du panier referme le panneau.
     */

    document.addEventListener("click", event => {

        const panel = document.getElementById("cartPanel");

        if (!panel || !panel.classList.contains("open")) return;

        if (panel.contains(event.target)) return;

        if (cartBtn && cartBtn.contains(event.target)) return;

        closeCartPanel();
    });

    document.addEventListener("keydown", event => {

        if (event.key !== "Escape") return;

        closeCartPanel();
        closeCheckout();
    });

    renderCart();
}


// ------------------------------------------------------
// LECTURE / ECRITURE DU PANIER
// ------------------------------------------------------

function cartStorageKey() {

    return "mc_cart_u" + (currentUser ? currentUser.id : "guest");
}


function loadCart() {

    try {

        const raw =
            JSON.parse(
                localStorage.getItem(cartStorageKey()) || "[]"
            );

        if (!Array.isArray(raw)) return [];

        const lines = [];

        for (const entry of raw) {

            const productId =
                Math.floor(Number(entry && entry.productId));

            const quantity =
                Math.floor(Number(entry && entry.quantity));

            if (
                !Number.isInteger(productId)
                || productId <= 0
                || !Number.isInteger(quantity)
                || quantity < 1
            ) {
                continue;
            }

            lines.push({
                productId,
                quantity: Math.min(quantity, MAX_CART_QUANTITY)
            });
        }

        return lines;

    } catch (error) {

        console.error(error);

        return [];
    }
}


function saveCart() {

    try {

        localStorage.setItem(
            cartStorageKey(),
            JSON.stringify(cart)
        );

    } catch (error) {

        console.error(error);
    }
}


function findProduct(productId) {

    return products.find(
        item => Number(item.id) === Number(productId)
    ) || null;
}


function cartLineQuantity(productId) {

    const line = cart.find(
        item => item.productId === Number(productId)
    );

    return line ? line.quantity : 0;
}


function cartArticleCount() {

    return cart.reduce(
        (sum, line) => sum + line.quantity,
        0
    );
}


/*
 * Sous-totaux par devise : le panier peut contenir des
 * articles en ETH et en BTC, qui ne se paient pas
 * dans la même transaction.
 */

function cartSubtotals() {

    const totals = new Map();

    for (const line of cart) {

        const product = findProduct(line.productId);

        if (!product) continue;

        const currency = product.currency;

        const amount =
            line.quantity * Number(product.price);

        totals.set(
            currency,
            Number(((totals.get(currency) || 0) + amount).toFixed(8))
        );
    }

    return totals;
}


function formatSubtotals(totals) {

    if (totals.size === 0) return "0";

    const parts = [];

    for (const [currency, amount] of totals) {
        parts.push(amount + " " + currency);
    }

    return parts.join(" + ");
}


// ------------------------------------------------------
// ACTIONS DU PANIER
// ------------------------------------------------------

function addToCart(product, quantity) {

    if (!product) return;

    const stock = Math.max(
        0,
        Math.floor(Number(product.stock) || 0)
    );

    if (stock < 1) {

        showMarketMessage(
            "Article en rupture de stock.",
            "err"
        );

        return;
    }

    const amount =
        Math.max(1, Math.floor(Number(quantity) || 1));

    const limit = Math.min(MAX_CART_QUANTITY, stock);

    const current = cartLineQuantity(product.id);

    const wanted = current + amount;

    const finalQuantity = Math.min(wanted, limit);

    const line = cart.find(
        item => item.productId === Number(product.id)
    );

    if (line) {
        line.quantity = finalQuantity;
    } else {
        cart.push({
            productId: Number(product.id),
            quantity: finalQuantity
        });
    }

    saveCart();
    renderCart();
    flashCartButton();

    if (finalQuantity < wanted) {

        showMarketMessage(
            "Stock limité : " + limit +
            " exemplaire(s) maximum pour cet article.",
            "err"
        );

        return;
    }

    showMarketMessage(
        "« " + product.name + " » ajouté au panier.",
        "ok"
    );
}


function setCartQuantity(productId, quantity) {

    const line = cart.find(
        item => item.productId === Number(productId)
    );

    if (!line) return;

    const product = findProduct(productId);

    const stock = product
        ? Math.max(0, Math.floor(Number(product.stock) || 0))
        : 0;

    const requested =
        Math.floor(Number(quantity) || 0);

    if (!Number.isInteger(requested) || requested < 1) {

        cartRemove(productId);

        return;
    }

    const limit = stock > 0
        ? Math.min(MAX_CART_QUANTITY, stock)
        : MAX_CART_QUANTITY;

    line.quantity = Math.min(requested, limit);

    saveCart();
    renderCart();

    if (requested > limit) {

        showMarketMessage(
            "Stock disponible : " + limit + " exemplaire(s).",
            "err"
        );
    }
}


function cartRemove(productId) {

    cart = cart.filter(
        item => item.productId !== Number(productId)
    );

    saveCart();
    renderCart();
}


function clearCart() {

    if (cart.length === 0) return;

    const confirmation = confirm(
        "Vider entièrement le panier ?"
    );

    if (!confirmation) return;

    cart = [];
    saveCart();
    renderCart();

    showMarketMessage("Panier vidé.", "ok");
}


// ------------------------------------------------------
// AFFICHAGE
// ------------------------------------------------------

function renderCart() {

    const itemsBox =
        document.getElementById("cartItems");

    const totalsBox =
        document.getElementById("cartTotals");

    const payBtn =
        document.getElementById("cartPayBtn");

    const clearBtn =
        document.getElementById("cartClearBtn");

    if (!itemsBox || !totalsBox) return;

    itemsBox.innerHTML = "";

    if (cart.length === 0) {

        const empty = document.createElement("p");

        empty.className = "cart-empty";
        empty.textContent = "Votre panier est vide.";

        itemsBox.appendChild(empty);

    } else {

        for (const line of cart) {
            itemsBox.appendChild(
                createCartRow(line)
            );
        }
    }

    const totals = cartSubtotals();

    totalsBox.innerHTML = "";

    const line = document.createElement("span");

    line.className = "cart-total-line";

    line.textContent = "Sous-total : ";

    const bold = document.createElement("b");

    bold.textContent = formatSubtotals(totals);

    line.appendChild(bold);

    totalsBox.appendChild(line);

    if (cart.length > 0) {

        const count = document.createElement("span");

        count.className = "cart-count-line";

        count.textContent =
            cartArticleCount() + " article(s)";

        totalsBox.appendChild(count);
    }

    if (payBtn) {

        payBtn.disabled =
            cart.length === 0 || checkoutInProgress;

        payBtn.textContent = checkoutInProgress
            ? "Paiement en cours..."
            : "Payer";
    }

    if (clearBtn) {
        clearBtn.disabled = cart.length === 0 || checkoutInProgress;
    }

    updateCartBadge();
}


function createCartRow(line) {

    const product = findProduct(line.productId);

    const row = document.createElement("div");
    row.className = "cart-row";

    const head = document.createElement("div");
    head.className = "cart-row-head";

    const name = document.createElement("span");
    name.className = "cart-row-name";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "cart-row-remove";
    removeBtn.title = "Retirer du panier";
    removeBtn.textContent = "×";
    removeBtn.addEventListener(
        "click",
        () => cartRemove(line.productId)
    );

    head.appendChild(name);
    head.appendChild(removeBtn);

    row.appendChild(head);

    if (!product) {

        name.textContent = "Article " + line.productId;

        const unavailable = document.createElement("p");
        unavailable.className = "cart-row-unavailable";
        unavailable.textContent =
            "Cet article n'est plus en vente. Retirez-le du panier.";

        row.appendChild(unavailable);

        return row;
    }

    name.textContent = product.name;

    const price = document.createElement("span");
    price.className = "cart-row-price";
    price.textContent =
        product.price + " " + product.currency + " / unité";

    row.appendChild(price);

    const controls = document.createElement("div");
    controls.className = "cart-row-controls";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "cart-qty-btn";
    minus.textContent = "−";
    minus.addEventListener(
        "click",
        () => setCartQuantity(line.productId, line.quantity - 1)
    );

    const input = document.createElement("input");
    input.type = "number";
    input.className = "cart-qty-input";
    input.min = "1";
    input.step = "1";
    input.value = String(line.quantity);

    input.addEventListener("change", () => {

        setCartQuantity(
            line.productId,
            Math.floor(Number(input.value) || 1)
        );
    });

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "cart-qty-btn";
    plus.textContent = "+";
    plus.addEventListener(
        "click",
        () => setCartQuantity(line.productId, line.quantity + 1)
    );

    const total = document.createElement("span");
    total.className = "cart-row-total";
    total.textContent =
        Number(
            (
                line.quantity * Number(product.price)
            ).toFixed(8)
        ) + " " + product.currency;

    controls.appendChild(minus);
    controls.appendChild(input);
    controls.appendChild(plus);
    controls.appendChild(total);

    row.appendChild(controls);

    return row;
}


function updateCartBadge() {

    const badge =
        document.getElementById("cartCount");

    if (!badge) return;

    const count = cartArticleCount();

    badge.textContent = String(count);

    badge.classList.toggle("has-items", count > 0);
}


function flashCartButton() {

    const cartBtn =
        document.getElementById("cartBtn");

    if (!cartBtn) return;

    cartBtn.classList.add("flash");

    window.setTimeout(
        () => cartBtn.classList.remove("flash"),
        CART_FLASH_MS
    );
}


function showMarketMessage(text, kind) {

    const message =
        document.getElementById("marketMessage");

    if (!message) return;

    message.className = "mc-message" + (kind ? " " + kind : "");
    message.textContent = text;
}


// ------------------------------------------------------
// PANNEAU
// ------------------------------------------------------

function toggleCartPanel() {

    const panel = document.getElementById("cartPanel");

    if (!panel) return;

    if (panel.classList.contains("open")) {
        closeCartPanel();
        return;
    }

    renderCart();

    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
}


function closeCartPanel() {

    const panel = document.getElementById("cartPanel");

    if (!panel) return;

    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
}


// ------------------------------------------------------
// PAIEMENT DU PANIER
// ------------------------------------------------------

function rememberDeliveryAddress(address) {

    try {

        localStorage.setItem("mc_delivery_last", address);

    } catch (error) {

        console.error(error);
    }
}


function lastDeliveryAddress() {

    try {

        return localStorage.getItem("mc_delivery_last") || "";

    } catch (error) {

        console.error(error);

        return "";
    }
}


function openCheckout() {

    if (cart.length === 0) {

        showMarketMessage(
            "Votre panier est vide.",
            "err"
        );

        return;
    }

    const summary =
        document.getElementById("checkoutSummary");

    const totalBox =
        document.getElementById("checkoutTotal");

    const delivery =
        document.getElementById("checkoutDelivery");

    const message =
        document.getElementById("checkoutMessage");

    summary.innerHTML = "";

    for (const line of cart) {

        const product = findProduct(line.productId);

        const row = document.createElement("div");
        row.className = "checkout-line";

        const label = document.createElement("span");

        label.textContent = (product ? product.name : "Article " + line.productId) +
            " × " + line.quantity;

        const amount = document.createElement("b");

        amount.textContent = product
            ? Number(
                (
                    line.quantity * Number(product.price)
                ).toFixed(8)
              ) + " " + product.currency
            : "-";

        row.appendChild(label);
        row.appendChild(amount);

        summary.appendChild(row);
    }

    totalBox.textContent =
        formatSubtotals(cartSubtotals());

    if (delivery && !delivery.value) {
        delivery.value = lastDeliveryAddress();
    }

    if (message) {
        message.className = "mc-message";
        message.textContent = "";
    }

    closeCartPanel();

    document.getElementById("checkoutModal").classList.add("open");
}


function closeCheckout() {

    const modal = document.getElementById("checkoutModal");

    if (!modal) return;

    modal.classList.remove("open");
}


async function confirmCheckout() {

    if (checkoutInProgress) return;

    const message =
        document.getElementById("checkoutMessage");

    if (cart.length === 0) {

        message.className = "mc-message err";
        message.textContent = "Votre panier est vide.";

        return;
    }

    const deliveryAddress =
        String(
            document.getElementById("checkoutDelivery").value || ""
        )
            .trim()
            .replace(/\s+/g, " ");

    if (deliveryAddress.length < MIN_DELIVERY_LENGTH) {

        message.className = "mc-message err";
        message.textContent =
            "Adresse de livraison requise " +
            "(" + MIN_DELIVERY_LENGTH + " caractères minimum).";

        document.getElementById("checkoutDelivery").focus();

        return;
    }

    /*
     * Un seul mot de passe pour tous les paiements
     * du panier.
     */
    const password = prompt(
        "Confirmez votre mot de passe pour signer le paiement du panier :"
    );

    if (!password) return;

    const items = cart.map(line => ({
        productId: line.productId,
        quantity: line.quantity
    }));

    checkoutInProgress = true;

    renderCart();

    message.className = "mc-message";
    message.textContent = "Paiement en cours...";

    try {

        const response = await fetch("/api/checkout", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: currentUser.id,
                password: password,
                deliveryAddress: deliveryAddress,
                items: items
            })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {

            message.className = "mc-message err";
            message.textContent =
                data.message || "Paiement impossible.";

            await refreshAfterPurchase();

            return;
        }

        /*
         * Seuls les articles réellement payés sortent
         * du panier (un panier multi-devises peut être
         * payé en partie seulement).
         */

        const paidIds =
            (data.paid_product_ids || []).map(Number);

        cart = cart.filter(
            line => !paidIds.includes(line.productId)
        );

        saveCart();
        rememberDeliveryAddress(deliveryAddress);

        await refreshAfterPurchase();

        const hashes = (data.paid || [])
            .map(group =>
                group.currency + " : " + group.tx_hash
            )
            .join("  |  ");

        if (data.failures && data.failures.length > 0) {

            message.className = "mc-message err";
            message.textContent =
                "Paiement partiel — " + hashes +
                ". Non payé : " + data.failures
                    .map(failure => failure.message)
                    .join(" ");

            return;
        }

        message.className = "mc-message ok";
        message.textContent =
            "Commande confirmée ! " + hashes +
            " — livraison : " + data.delivery_address;

        setTimeout(closeCheckout, 3000);

    } catch (error) {

        console.error(error);

        message.className = "mc-message err";
        message.textContent =
            "Impossible de contacter le serveur.";

    } finally {

        checkoutInProgress = false;

        renderCart();
    }
}


async function refreshAfterPurchase() {

    await Promise.all([
        loadProducts(),
        loadBalances()
    ]);

    reconcileCart();
    renderCart();
}
