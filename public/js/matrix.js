/*
 * public/js/matrix.js
 *
 * Fond d'écran "Matrix" pour Mc Market.
 * Canvas plein écran, pluie de caractères verts + bits,
 * derrière tout le contenu (z-index -1).
 */

(function () {
    const canvas = document.createElement("canvas");
    canvas.id = "matrix-canvas";

    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.zIndex = "-1";
    canvas.style.pointerEvents = "none";

    document.body.prepend(canvas);

    const ctx = canvas.getContext("2d");

    const CHARS =
        "アカサタナハマヤラワ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZｦｧｨｩｪｫ$€₿Ξ";

    const FONT_SIZE = 16;

    let columns = 0;
    let drops = [];

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        columns = Math.floor(canvas.width / FONT_SIZE);
        drops = [];

        for (let i = 0; i < columns; i++) {
            drops[i] = Math.floor(
                Math.random() * (canvas.height / FONT_SIZE)
            );
        }
    }

    window.addEventListener("resize", resize);
    resize();

    function draw() {
        /*
         * Voile noir semi-transparent : laisse une traînée.
         */
        ctx.fillStyle = "rgba(2, 8, 3, 0.09)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.font = FONT_SIZE + "px monospace";

        for (let i = 0; i < drops.length; i++) {

            const char =
                CHARS.charAt(
                    Math.floor(Math.random() * CHARS.length)
                );

            const x = i * FONT_SIZE;
            const y = drops[i] * FONT_SIZE;

            /*
             * Tête de la pluie : vert très clair / doré parfois.
             */
            if (Math.random() > 0.995) {
                ctx.fillStyle = "#ffd34d";
            } else {
                ctx.fillStyle = "#c8ffb0";
            }

            ctx.fillText(char, x, y);

            /*
             * Corps : vert Matrix.
             */
            ctx.fillStyle = "#00b326";
            ctx.fillText(char, x, y - FONT_SIZE);

            if (
                y > canvas.height
                && Math.random() > 0.975
            ) {
                drops[i] = 0;
            }

            drops[i]++;
        }
    }

    setInterval(draw, 50);
})();
