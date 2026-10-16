const loginForm = document.getElementById("loginForm");
const message = document.getElementById("message");

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    // Vérification simple
    if (!email || !password) {
        message.className = "mc-message err";
        message.textContent = "Veuillez remplir tous les champs.";
        return;
    }

    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: email,
                password: password
            })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            message.className = "mc-message err";
            message.textContent =
                data.message || "Connexion impossible.";
            return;
        }

        console.log("Login réussi :", data.user);

        // Sauvegarder les informations de l'utilisateur
        localStorage.setItem("user", JSON.stringify(data.user));

        message.className = "mc-message ok";
        message.textContent = "Connexion réussie !";

        // Redirection selon le rôle
        setTimeout(() => {
            if (data.user.role === "admin") {
                window.location.href = "/admin.html";
            } else {
                window.location.href = "/market.html";
            }
        }, 500);

    } catch (error) {
        console.error("Login error:", error);
        message.className = "mc-message err";
        message.textContent = "Impossible de contacter le serveur.";
    }
});
