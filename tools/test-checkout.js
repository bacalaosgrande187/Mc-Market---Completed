/*
 * tools/test-checkout.js
 *
 * Tests du panier de la boutique Mc Market.
 *
 * A lancer pendant que le serveur tourne :
 *
 *     node tools/test-checkout.js
 *
 * Le script ne fait aucun envoi on-chain reel : le wallet
 * de test est vide, donc /api/checkout doit s'arreter sur
 * le controle de solde.
 */

const BASE = "http://localhost:" + (process.env.PORT || 3000);

const ADMIN = {
    userId: 1,
    password: process.env.ADMIN_PASSWORD
};

const ADDRESS = "12 rue des Lilas, 75011 Paris, France";

let passed = 0;

let failed = 0;


function check(label, condition, detail) {

    if (condition) {
        passed += 1;
        console.log("  OK   " + label);
    } else {
        failed += 1;
        console.log("  FAIL " + label + " -> " + detail);
    }
}


async function post(body) {

    const response = await fetch(BASE + "/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    let data = null;

    try {
        data = await response.json();
    } catch (error) {
        data = { raw: "reponse non JSON" };
    }

    return { status: response.status, data };
}


async function main() {

    console.log("Tests du panier Mc Market (" + BASE + ")\n");


    // 1. Catalogue
    console.log("1. GET /api/products");

    const catalogResponse = await fetch(BASE + "/api/products");

    const catalog = await catalogResponse.json();

    const products =
        Array.isArray(catalog) ? catalog :
        (catalog.products || []);

    check(
        "produits retournes",
        products.length >= 6,
        "recu " + products.length
    );

    const ethProduct =
        products.find(p => p.currency === "ETH");

    const btcProduct =
        products.find(p => p.currency === "BTC");

    check("article ETH present", !!ethProduct, "aucun");
    check("article BTC present", !!btcProduct, "aucun");


    // 2. Panier vide
    console.log("\n2. POST /api/checkout - panier vide");

    let result = await post({
        userId: ADMIN.userId,
        password: ADMIN.password,
        deliveryAddress: ADDRESS,
        items: []
    });

    check(
        "400 + panier vide",
        result.status === 400 &&
        /vide/i.test(result.data.message || ""),
        result.status + " " + JSON.stringify(result.data)
    );


    // 3. Adresse de livraison manquante
    console.log("\n3. POST /api/checkout - sans adresse");

    result = await post({
        userId: ADMIN.userId,
        password: ADMIN.password,
        items: [{ productId: ethProduct.id, quantity: 1 }]
    });

    check(
        "400 + adresse requise",
        result.status === 400 &&
        /adresse/i.test(result.data.message || ""),
        result.status + " " + JSON.stringify(result.data)
    );


    // 4. Article inexistant
    console.log("\n4. POST /api/checkout - article inexistant");

    result = await post({
        userId: ADMIN.userId,
        password: ADMIN.password,
        deliveryAddress: ADDRESS,
        items: [{ productId: 999999, quantity: 1 }]
    });

    check(
        "404 + article introuvable",
        result.status === 404,
        result.status + " " + JSON.stringify(result.data)
    );


    // 5. Quantite invalide
    console.log("\n5. POST /api/checkout - quantite invalide");

    result = await post({
        userId: ADMIN.userId,
        password: ADMIN.password,
        deliveryAddress: ADDRESS,
        items: [{ productId: ethProduct.id, quantity: 0 }]
    });

    check(
        "400 + quantite invalide",
        result.status === 400 &&
        /quantite|quantit/i.test(result.data.message || ""),
        result.status + " " + JSON.stringify(result.data)
    );


    // 6. Stock insuffisant
    console.log("\n6. POST /api/checkout - stock insuffisant");

    result = await post({
        userId: ADMIN.userId,
        password: ADMIN.password,
        deliveryAddress: ADDRESS,
        items: [{ productId: ethProduct.id, quantity: 900 }]
    });

    check(
        "400 + stock insuffisant",
        result.status === 400 &&
        /stock/i.test(result.data.message || ""),
        result.status + " " + JSON.stringify(result.data)
    );


    // 7. Mauvais mot de passe
    console.log("\n7. POST /api/checkout - mauvais mot de passe");

    result = await post({
        userId: ADMIN.userId,
        password: "ce-n-est-pas-le-bon",
        deliveryAddress: ADDRESS,
        items: [{ productId: ethProduct.id, quantity: 1 }]
    });

    check(
        "401 + mot de passe incorrect",
        result.status === 401,
        result.status + " " + JSON.stringify(result.data)
    );


    // 8. Panier valide multi-devises -> controle de solde
    console.log(
        "\n8. POST /api/checkout - panier ETH + BTC valide"
    );

    const started = Date.now();

    result = await post({
        userId: ADMIN.userId,
        password: ADMIN.password,
        deliveryAddress: ADDRESS,
        items: [
            { productId: ethProduct.id, quantity: 2 },
            { productId: btcProduct.id, quantity: 1 }
        ]
    });

    check(
        "arret sur le controle de solde (aucun envoi)",
        result.status === 400 &&
        /solde|fonds/i.test(result.data.message || ""),
        result.status + " " + JSON.stringify(result.data)
    );

    console.log(
        "     reponse : " + (result.data.message || "")
    );

    console.log(
        "     duree   : " + (Date.now() - started) + " ms"
    );


    // 9. Le stock n'a pas ete modifie par les tests
    console.log("\n9. Verification du stock apres tests");

    const afterResponse = await fetch(BASE + "/api/products");

    const after = await afterResponse.json();

    const afterProducts =
        Array.isArray(after) ? after : (after.products || []);

    const ethAfter =
        afterProducts.find(p => p.id === ethProduct.id);

    check(
        "stock ETH inchange",
        Number(ethAfter.stock) === Number(ethProduct.stock),
        "avant " + ethProduct.stock + " / apres " + ethAfter.stock
    );


    console.log(
        "\nResultat : " + passed + " OK, " + failed + " echec(s)"
    );

    process.exitCode = failed ? 1 : 0;
}


main().catch(error => {

    console.error("ERREUR TEST:", error);

    process.exitCode = 2;
});
