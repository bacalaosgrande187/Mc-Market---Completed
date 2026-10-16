/*
 * public/js/admin.js
 *
 * Panneau administrateur Mc Market.
 * - Déverrouillage par mot de passe (rôle admin exigé côté serveur)
 * - CRUD complet des articles en vente
 * - Consultation des commandes
 */

let currentUser = null;
let adminPassword = null;
let editingProductId = null;

// ======================================================
// INITIALISATION
// ======================================================

document.addEventListener("DOMContentLoaded", () => {

    currentUser =
        JSON.parse(
            localStorage.getItem("user") || "null"
        );

    if (!currentUser || !currentUser.id) {
        window.location.href = "/login.html";
        return;
    }

    if (currentUser.role !== "admin") {
        document.getElementById("lockMessage").className = "mc-message err";
        document.getElementById("lockMessage").textContent =
            "Ce compte n'est pas administrateur.";
        return;
    }

    setupLogout();

    const pwdInput = document.getElementById("adminPassword");

    pwdInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") unlockAdmin();
    });
});

// ======================================================
// DECONNEXION
// ======================================================

function setupLogout() {

    const btn = document.getElementById("logoutBtn");

    if (!btn) return;

    btn.addEventListener("click", () => {
        localStorage.removeItem("user");
        sessionStorage.removeItem("adminPassword");
        window.location.href = "/login.html";
    });
}

// ======================================================
// DEVERROUILLAGE ADMIN
// ======================================================

async function unlockAdmin() {

    const message =
        document.getElementById("lockMessage");

    const password =
        document.getElementById("adminPassword").value;

    if (!password) {
        message.className = "mc-message err";
        message.textContent = "Entrez le mot de passe.";
        return;
    }

    try {

        const response = await fetch("/api/admin/verify", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: currentUser.id,
                password: password
            })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            message.className = "mc-message err";
            message.textContent =
                data.message || "Accès refusé.";
            return;
        }

        adminPassword = password;
        sessionStorage.setItem("adminPassword", password);

        document.getElementById("lockScreen").style.display = "none";
        document.getElementById("adminPanel").style.display = "";

        await Promise.all([
            loadProducts(),
            loadOrders()
        ]);

    } catch (error) {

        console.error(error);

        message.className = "mc-message err";
        message.textContent = "Impossible de contacter le serveur.";
    }
}

// ======================================================
// ARTICLES
// ======================================================

async function loadProducts() {

    const tbody =
        document.getElementById("productsTableBody");

    try {

        const response = await fetch("/api/admin/products", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: currentUser.id,
                password: adminPassword
            })
        });

        if (response.status === 401 || response.status === 403) {
            lockAgain();
            return;
        }

        const data = await response.json();

        const products = data.products || [];

        tbody.innerHTML = "";

        if (products.length === 0) {
            tbody.innerHTML =
                "<tr><td colspan='6'>Aucun article.</td></tr>";
            return;
        }

        for (const product of products) {

            const tr = document.createElement("tr");

            tr.innerHTML = `
                <td>${product.id}</td>
                <td></td>
                <td>${product.price} ${product.currency}</td>
                <td>${product.stock}</td>
                <td>
                    <span class="badge ${product.active ? "ok" : "off"}">
                        ${product.active ? "En vente" : "Retiré"}
                    </span>
                </td>
                <td>
                    <div class="inline-actions">
                        <button data-act="edit">Modifier</button>
                        <button data-act="toggle">
                            ${product.active ? "Retirer" : "Remettre"}
                        </button>
                        <button data-act="delete" class="delete">Supprimer</button>
                    </div>
                </td>
            `;

            tr.children[1].textContent = product.name;

            tr.querySelector("[data-act='edit']")
                .addEventListener("click", () => startEdit(product));

            tr.querySelector("[data-act='toggle']")
                .addEventListener("click", () => toggleProduct(product));

            tr.querySelector("[data-act='delete']")
                .addEventListener("click", () => deleteProduct(product));

            tbody.appendChild(tr);
        }

    } catch (error) {

        console.error(error);

        tbody.innerHTML =
            "<tr><td colspan='6'>Erreur de chargement.</td></tr>";
    }
}

function startEdit(product) {

    editingProductId = product.id;

    document.getElementById("formTitle").textContent =
        "Modifier l'article #" + product.id;

    document.getElementById("pName").value = product.name;
    document.getElementById("pPrice").value = product.price;
    document.getElementById("pCurrency").value = product.currency;
    document.getElementById("pStock").value = product.stock;
    document.getElementById("pImage").value = product.image_url || "";
    document.getElementById("pDesc").value = product.description || "";
    document.getElementById("pActive").value =
        product.active ? "1" : "0";

    document.getElementById("cancelEdit").style.display = "";
    document.getElementById("pName").focus();
}

function resetForm() {

    editingProductId = null;

    document.getElementById("formTitle").textContent =
        "Ajouter un article";

    document.getElementById("productForm").reset();

    document.getElementById("cancelEdit").style.display = "none";
}

async function saveProduct(event) {

    event.preventDefault();

    const message =
        document.getElementById("adminMessage");

    const payload = {
        userId: currentUser.id,
        password: adminPassword,
        name: document.getElementById("pName").value.trim(),
        description: document.getElementById("pDesc").value.trim(),
        price: Number(document.getElementById("pPrice").value),
        currency: document.getElementById("pCurrency").value,
        stock: Number(document.getElementById("pStock").value),
        image_url: document.getElementById("pImage").value.trim(),
        active: Number(document.getElementById("pActive").value)
    };

    if (editingProductId) {
        payload.productId = editingProductId;
    }

    message.className = "mc-message";
    message.textContent = "Enregistrement...";

    try {

        const response = await fetch("/api/admin/products", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.status === 401 || response.status === 403) {
            lockAgain();
            return;
        }

        if (!response.ok || !data.success) {
            message.className = "mc-message err";
            message.textContent = data.message || "Échec.";
            return;
        }

        message.className = "mc-message ok";
        message.textContent = editingProductId
            ? "Article modifié."
            : "Article ajouté.";

        resetForm();

        await loadProducts();

    } catch (error) {

        console.error(error);

        message.className = "mc-message err";
        message.textContent = "Impossible de contacter le serveur.";
    }
}

async function toggleProduct(product) {

    const message =
        document.getElementById("adminMessage");

    message.className = "mc-message";
    message.textContent = "Mise à jour...";

    try {

        const response = await fetch("/api/admin/products/toggle", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: currentUser.id,
                password: adminPassword,
                productId: product.id
            })
        });

        const data = await response.json();

        if (response.status === 401 || response.status === 403) {
            lockAgain();
            return;
        }

        message.className = "mc-message ok";
        message.textContent = data.message || "Mis à jour.";

        await loadProducts();

    } catch (error) {

        console.error(error);

        message.className = "mc-message err";
        message.textContent = "Impossible de contacter le serveur.";
    }
}

async function deleteProduct(product) {

    if (!confirm(
        "Supprimer définitivement l'article \"" + product.name + "\" ?"
    )) {
        return;
    }

    const message =
        document.getElementById("adminMessage");

    message.className = "mc-message";
    message.textContent = "Suppression...";

    try {

        const response = await fetch("/api/admin/products/delete", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: currentUser.id,
                password: adminPassword,
                productId: product.id
            })
        });

        const data = await response.json();

        if (response.status === 401 || response.status === 403) {
            lockAgain();
            return;
        }

        message.className = "mc-message ok";
        message.textContent = data.message || "Supprimé.";

        if (editingProductId === product.id) {
            resetForm();
        }

        await loadProducts();

    } catch (error) {

        console.error(error);

        message.className = "mc-message err";
        message.textContent = "Impossible de contacter le serveur.";
    }
}

// ======================================================
// COMMANDES
// ======================================================

async function loadOrders() {

    const tbody =
        document.getElementById("ordersTableBody");

    try {

        const response = await fetch("/api/admin/orders", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: currentUser.id,
                password: adminPassword
            })
        });

        if (response.status === 401 || response.status === 403) {
            lockAgain();
            return;
        }

        const data = await response.json();

        const orders = data.orders || [];

        tbody.innerHTML = "";

        if (orders.length === 0) {
            tbody.innerHTML =
                "<tr><td colspan='8'>Aucune commande.</td></tr>";
            return;
        }

        for (const order of orders) {

            const tr = document.createElement("tr");

            tr.innerHTML = `
                <td>${order.id}</td>
                <td></td>
                <td></td>
                <td>${order.quantity}</td>
                <td>${order.total} ${order.currency}</td>
                <td title="${order.tx_hash || ""}"></td>
                <td></td>
                <td>${order.created_at}</td>
            `;

            tr.children[1].textContent = order.username || "-";
            tr.children[2].textContent = order.product_name;
            tr.children[5].textContent =
                order.tx_hash
                    ? order.tx_hash.slice(0, 10) + "…"
                    : "-";

            /*
                Adresse de livraison fournie par le client au paiement.
            */

            const delivery =
                order.delivery_address || "-";

            tr.children[6].textContent = delivery;
            tr.children[6].title = delivery;

            tbody.appendChild(tr);
        }

    } catch (error) {

        console.error(error);

        tbody.innerHTML =
            "<tr><td colspan='8'>Erreur de chargement.</td></tr>";
    }
}

// ======================================================
// RETOUR AU VERROU SI SESSION EXPIREE
// ======================================================

function lockAgain() {

    adminPassword = null;
    sessionStorage.removeItem("adminPassword");

    document.getElementById("adminPanel").style.display = "none";
    document.getElementById("lockScreen").style.display = "";

    const message = document.getElementById("lockMessage");
    message.className = "mc-message err";
    message.textContent = "Session expirée, revalidez le mot de passe.";
}
