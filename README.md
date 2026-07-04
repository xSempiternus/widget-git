# GIT ARCADE 🕹️

Widget arcade para VSCode: **CHECK main** (fetch + avisa) y **PULL main** (integra `origin/main` de forma segura) sobre cualquier proyecto/repo, no solo Fidelya.

- Auto-detecta proyectos escaneando `gitArcade.rootPath` (default `Documents\PROJECTS`).
- Agrupa por carpeta: los repos hermanos (ej. `Fidelya-backend` + `Fidelya-frontend`) forman un mismo proyecto.
- **CHECK** (botón verde): `git fetch origin main` y cuenta commits pendientes. No pullea.
- **PULL** (botón ámbar): `git pull origin main --no-rebase`. Omite repos con cambios sin commitear y aborta en conflicto.
- **COMMIT** / **PUSH**: `git add -A` + commit con tu mensaje, y push (crea upstream si falta).
- **Estado por repo**: rama actual, ahead/behind vs remoto, nº de cambios, y lista desplegable de archivos modificados (solo lectura).
- **Rama**: dropdown para cambiar de rama y botón `+` para crear una nueva (aplica a todos los repos del proyecto).

Es una **alternativa simplificada al Source Control** de VSCode: sin stagear archivo por archivo ni diffs, enfocada en lo esencial y multi-repo.

## Sincronización con VSCode (v2.2)
- **Extensión → VSCode/terminal**: al cambiar de rama, hace `git checkout` real (la terminal ya queda alineada) y fuerza `git.refresh` para que el indicador de rama nativo se actualice al instante.
- **Elegir un proyecto en el dropdown** abre su carpeta como workspace en VSCode (`vscode.openFolder`); si ya está abierta, solo refresca.
- **VSCode/terminal → Extensión**: un `fs.watch` sobre `.git/HEAD` de cada repo del proyecto detecta cambios de rama hechos por fuera y refresca el estado solo.
- **Auto-seleccionar**: al enfocar una carpeta/archivo en VSCode, la extensión selecciona automáticamente el proyecto correspondiente.

## Uso
1. Recarga VSCode (`Ctrl+Shift+P` → *Developer: Reload Window*).
2. Clic en **🕹 GIT ARCADE** (abajo-izquierda) o en el icono del joystick de la barra de actividades. También `Ctrl+Shift+P` → *GIT ARCADE: Abrir widget*.
3. Elige proyecto en el dropdown y presiona un botón.

Es una **vista fijable**: arrástrala a la barra lateral secundaria (derecha) o al panel inferior para dejarla anclada y pequeña. También puedes arrastrarla a una **ventana flotante** (VSCode ≥1.85, ventanas auxiliares) para mantenerla siempre encima.

## Config
- `gitArcade.rootPath` — carpeta raíz a escanear.
- `gitArcade.scanDepth` — profundidad (default 4).
- `gitArcade.mainBranch` — fuerza una rama; vacío = auto (origin/HEAD → main → master).
- Tras crear un proyecto nuevo: *GIT ARCADE: Re-escanear proyectos*.

## Instalar / actualizar
Copiar `package.json` + `extension.js` a `%USERPROFILE%\.vscode\extensions\git-arcade\` y recargar la ventana.
