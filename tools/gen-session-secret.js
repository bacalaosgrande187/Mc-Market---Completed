/* =====================================================
   gen-session-secret.js

   Ajoute SESSION_SECRET au .env s'il est absent.
   Le secret n'est jamais affiché en clair.

   Usage : node tools/gen-session-secret.js
   ===================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const envPath = path.join(__dirname, "..", ".env");

if (!fs.existsSync(envPath)) {
    console.error("ERREUR : .env introuvable (" + envPath + ")");
    process.exit(1);
}

let content = fs.readFileSync(envPath, "utf8");

if (/^\s*SESSION_SECRET\s*=/m.test(content)) {
    console.log("SESSION_SECRET déjà présent dans le .env : aucune modification.");
    process.exit(0);
}

const secret = crypto.randomBytes(32).toString("hex");

if (!content.endsWith("\n")) {
    content += "\n";
}

content +=
    "\n# Clé de signature des cookies de session (généré automatiquement)\n" +
    "SESSION_SECRET=" + secret + "\n";

fs.writeFileSync(envPath, content, "utf8");

console.log(
    "SESSION_SECRET ajouté au .env (" +
    secret.length +
    " caractères hexadécimaux, valeur non affichée)."
);