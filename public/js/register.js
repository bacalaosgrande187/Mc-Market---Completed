const registerForm = document.getElementById("registerForm");
const message = document.getElementById("message");

registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = document.getElementById("username").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const confirmPassword = document.getElementById("confirmPassword").value;

    message.className = "mc-message";
    message.textContent = "";

    if (password !== confirmPassword) {
        message.className = "mc-message err";
        message.textContent = "Les mots de passe ne correspondent pas.";
        return;
    }

    try {
        const response = await fetch("/api/register", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username: username,
                email: email,
                password: password
            })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            message.className = "mc-message err";
            message.textContent =
                data.message || "Inscription impossible.";
            return;
        }

        message.className = "mc-message ok";
        message.textContent =
            data.message || "Compte créé ! Redirection...";

        registerForm.reset();

        // Redirection vers la connexion
        setTimeout(() => {
            window.location.href = "/login.html";
        }, 900);

    } catch (error) {
        console.error(error);
        message.className = "mc-message err";
        message.textContent = "Impossible de contacter le serveur.";
    }
});
