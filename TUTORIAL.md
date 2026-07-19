# Tutorial: mi flujo con Brew ☕

Este es el paso a paso de cómo uso **Brew** para manejar mis repos sin marearme con git. Lo escribo como se lo explicaría a alguien al lado mío. La idea no es que memorices comandos, sino que entiendas *qué está pasando* y qué botón apretar en cada momento.

Si querés el "por qué" profundo de las ramas y el famoso "ahead N", saltá al final: **[El concepto que te salva la vida](#el-concepto-que-te-salva-la-vida)**.

---

## Antes de empezar: el mapa mental

Brew no es magia, es un panel que corre comandos de git por vos y te muestra el estado en cristiano. Todo gira alrededor de **4 botones**:

- **Check** → mira si hay novedades en el servidor (no toca nada).
- **Pull** → baja lo nuevo a tu rama.
- **Commit** → guarda tus cambios en la historia local.
- **Push** → sube tus commits a GitHub.

El orden natural de trabajo es: **Check → (trabajás) → Commit → Push**. Y cuando alguien más subió cosas: **Check → Pull**.

Lo importante: **fijate siempre en el asistente** (el texto que aparece arriba con el estado). Ese te dice qué conviene hacer. Si el asistente y tu instinto no coinciden, ganá el asistente.

---

## Paso 0 — Abrir el proyecto

1. En VSCode hago **File → Open Folder** y abro mi repo (ej. Fidelya).
2. Abro Brew: clic en **☕ Brew** abajo en la barra de estado, o en el ícono de la barra de actividades.
3. En el dropdown de arriba elijo el proyecto. Si abrí la carpeta, normalmente ya queda auto-seleccionado.

> Si Brew agrupa `Fidelya-backend` y `Fidelya-frontend` juntos, es a propósito: son un mismo proyecto y las acciones se aplican a los dos a la vez. Eso está bueno, no lo pelees.

---

## Paso 1 — Mirar dónde estoy parado (Check)

Lo primero que hago SIEMPRE, antes de tocar nada:

1. Miro la **rama actual** (arriba, en el dropdown de rama). Esto ya me saca la duda de "¿en qué rama estoy?".
2. Apreto **Check**.

Check hace un `fetch` y me dice si el servidor tiene commits que yo no tengo. **No baja nada, no rompe nada.** Es puro "avisame cómo viene la mano".

Después de Check, leo el asistente. Los mensajes típicos:

- *"Estás al día"* → perfecto, a trabajar.
- *"Hay N commits nuevos en el remoto ↓ — dale Pull"* → alguien subió cosas, tengo que bajarlas.
- *"Tenés N commits sin pushear ↑ — dale Push"* → tengo trabajo local que subir.

---

## Paso 2 — Traer lo nuevo (Pull)

Si el asistente me dice que hay cosas nuevas en el remoto:

1. Apreto **Pull**.

Brew hace el pull por mí. Dos cosas importantes que hace solo:

- Si tengo **cambios sin commitear**, se salta ese repo y no pisa nada (para no perder mi laburo).
- Si hay **conflicto**, aborta y me avisa, en vez de dejarme un merge a medio hacer.

Si me saltó un repo por cambios sin commitear, primero commiteo (Paso 3) y después vuelvo a hacer Pull.

---

## Paso 3 — Guardar mi trabajo (Commit)

Cuando terminé de tocar código:

1. Escribo el mensaje en la cajita de texto.
2. **Si me da fiaca pensar el mensaje**, apreto la **✨ (Sugerir)**: Brew lee el diff y me arma un mensaje solo (con el tipo, el scope y una viñeta por archivo). Si mi repo ya usa Conventional Commits, lo respeta. Lo reviso, lo ajusto si hace falta, y listo.
3. Apreto **Commit**.

Brew hace `git add -A` + commit. Si no había nada para guardar, me lo dice y no pasa nada.

---

## Paso 4 — Subir a GitHub (Push)

1. Apreto **Push**.

Brew sube mis commits. Si la rama es nueva y no existe en el servidor, **crea el upstream solo** (no tengo que andar con el "Publish Branch" de VSCode).

Si algo falla, el asistente me dice qué es:

- **Problema de credenciales** → me sugiere `gh auth login` o revisar el Git Credential Manager.
- **El remoto va adelante** → me dice que haga Pull primero y reintente Push.

---

## Paso 5 — Cambiar de rama / crear una rama

- **Cambiar de rama**: uso el dropdown de rama. Brew hace un `git checkout` real, así que la terminal y el indicador nativo de VSCode quedan alineados al toque. No tengo que hacer nada extra.
- **Crear una rama nueva**: apreto el **+**. La crea en todos los repos del proyecto.
- **Volver a la principal**: cuando estoy fuera de main/master y es seguro volver, aparece el botón **⌂ Ir a main**. Le doy y vuelvo sin drama.

---

## El concepto que te salva la vida

Esto es lo que más me costó entender y lo que más confunde a todos. Va derecho al grano.

### "Tengo 272 commits sin pushear" en una rama que yo no toqué

Te parás en una rama (ej. `flyio-new-files`) y VSCode grita: **"272 commits sin pushear" (ahead 272)**. Vos no hiciste esos cambios. Pánico. **Frená.**

**El concepto clave:** una rama en git NO es una carpeta con "tus cambios". Es solo una **etiqueta (un puntero) que apunta a un commit**.

"ahead 272" NO significa "hiciste 272 commits". Significa: *"tu rama local tiene 272 commits que su pareja remota (`origin/rama`) todavía no tiene."* Es una **comparación entre dos punteros**, no una lista de tu trabajo.

### Cómo se llega a eso (el caso Fly.io real)

1. `fly launch` crea un commit ("New files from Fly.io Launch") encima de main y le cuelga la rama `flyio-new-files`, que sube al servidor.
2. El equipo sigue laburando en main → main crece 272 commits (de varios autores, no solo vos).
3. Tu rama local `flyio-new-files` termina apuntando al mismo commit avanzado que main, pero la etiqueta **remota** `origin/flyio-new-files` quedó congelada en el commit del día 1.
4. Git compara local vs. remota de esa rama → ve un hueco de 272 → "ahead 272".

Ese "ahead" es **un fantasma**: son commits que ya están en `origin/main`. Brew esto lo detecta y te lo marca como **"ya en main"** para que no te asustes.

### La regla mental

> Las ramas son etiquetas móviles. "ahead/behind" compara punteros, no mide tu trabajo. Un feature ya fusionado deja su rama vieja apuntando atrás, aunque su código ya viva en main.

### Qué hago yo en ese caso

- Si es una rama de bot/ajena y solo estoy "parado" ahí → **NO pusheo ese hueco**. Esos commits ya están en el server.
- Simplemente hago **⌂ Ir a main** (o `git switch main`). Eso no borra ni modifica ninguna rama; solo mueve dónde estoy parado.
- Ramas viejas ya fusionadas (0 commits únicos vs. main): su código ya vive en main. Borrarlas es solo higiene, nunca urgente. Y ramas ajenas **no las borro por mi cuenta**, es decisión del equipo.

---

## Resumen de bolsillo

```
1. Abrir carpeta → elegir proyecto en Brew
2. Check          → ¿cómo viene la mano?
3. Pull           → si hay cosas nuevas en el server
4. (trabajo)
5. ✨ Sugerir → Commit  → guardo mi laburo
6. Push           → lo subo
```

Y si ves un "ahead" gigante en una rama que no tocaste: **respirá, es un fantasma, andá a main.** ☕
</content>
