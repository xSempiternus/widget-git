# Brew ☕ (GIT ARCADE)

Panel de git tipo cafetería para VS Code: **Check / Pull / Commit / Push**, cambio de rama y estado por repo, sobre **cualquier** proyecto detectado en tu disco. Una alternativa simplificada al Source Control nativo, enfocada en lo esencial y **multi-repo**.

![versión](https://img.shields.io/badge/version-2.3.0-e0912f) ![licencia](https://img.shields.io/badge/license-MIT-a6cf8f)

## Funciones

- **Auto-detección de proyectos**: escanea `gitArcade.rootPath` (default `Documents\PROJECTS`) + `extraPaths`. Agrupa repos hermanos (ej. `app-backend` + `app-frontend`) como un mismo proyecto.
- **Check**: `git fetch --all --prune` y cuenta commits pendientes de **tu rama** vs su remoto. No integra nada.
- **Pull**: `git pull --no-rebase` de tu rama actual (enlaza el upstream si falta). Omite repos con cambios sin commitear y aborta limpio en conflicto.
- **Commit / Push**: `git add -A` + commit con tu mensaje, y push (crea el upstream automáticamente si es una rama nueva).
- **Sugerir mensaje** (✨): analiza el diff real y propone un mensaje (detecta tipo feat/fix/docs… y arma asunto + cuerpo).
- **Estado por repo**: rama, ahead/behind, nº de cambios y lista desplegable de archivos modificados (solo lectura).
- **Rama**: dropdown para cambiar y `+` para crear una nueva (aplica a todos los repos del proyecto).
- **Feedback claro**: cada botón muestra un estado **hecho** (verde con ✓) al terminar su acción.

## Personalizar el fondo 🖼️

El panel trae un fondo de cafetería muy sutil, y **puedes ponerle cualquier imagen**:

- Clic en el **icono de imagen** (arriba a la derecha del panel) → *Elegir imagen…* o *Restaurar fondo por defecto*.
- O desde la paleta: *GIT ARCADE: Cambiar fondo del panel* / *Restaurar fondo por defecto*.
- Ajusta la intensidad con `gitArcade.backgroundOpacity` (`0` = oculta, `1` = plena; default `0.14`, muy sutil).

El fondo se aplica **en caliente** (sin recargar) y es responsive (escala a cubrir el panel). Las imágenes se embeben para que el webview pueda mostrarlas; si eliges una muy grande (>6 MB) se te avisa.

## Sincronización con VS Code

- **Extensión → editor/terminal**: al cambiar de rama hace `git checkout` real y fuerza `git.refresh`.
- **Elegir proyecto** abre su carpeta como workspace; si ya está abierta, solo refresca.
- **Editor/terminal → extensión**: un `fs.watch` sobre `.git/HEAD` detecta cambios de rama externos y refresca solo.
- **Auto-seleccionar**: al enfocar una carpeta/archivo, selecciona el proyecto correspondiente.

## Uso

1. Recarga VS Code (`Ctrl+Shift+P` → *Developer: Reload Window*).
2. Clic en **☕ Brew** (barra de estado, abajo-izquierda) o en el icono de la barra de actividades. También *GIT ARCADE: Abrir widget*.
3. Elige proyecto y presiona un botón.

Es una **vista fijable**: arrástrala a la barra lateral secundaria o al panel inferior, o a una **ventana flotante** (VS Code ≥1.85) para mantenerla siempre encima.

## Configuración

| Ajuste | Descripción |
| --- | --- |
| `gitArcade.rootPath` | Carpeta raíz principal a escanear. |
| `gitArcade.extraPaths` | Carpetas adicionales a escanear. |
| `gitArcade.scanDepth` | Profundidad máxima (default 4). |
| `gitArcade.mainBranch` | Fuerza una rama; vacío = auto (origin/HEAD → main → master). |
| `gitArcade.backgroundImage` | Ruta a una imagen de fondo personalizada; vacío = fondo por defecto. |
| `gitArcade.backgroundOpacity` | Intensidad del fondo (0–1, default 0.14). |

Tras crear un proyecto nuevo: *GIT ARCADE: Re-escanear proyectos* (o el icono de escanear del panel).

## Instalar / actualizar

**Opción A — copiar** `package.json`, `extension.js` y `media/` a `%USERPROFILE%\.vscode\extensions\git-arcade\` y recargar la ventana.

**Opción B — enlace (desarrollo)**: crear un *junction* para que la extensión instalada siga a tu repo (edición en vivo):

```powershell
cmd /c mklink /J "$env:USERPROFILE\.vscode\extensions\git-arcade" "C:\ruta\a\git-arcade"
```

Luego, cualquier cambio en el repo se refleja recargando la ventana.

## Licencia

[MIT](LICENSE) © Nikolas
