# Brew ☕

**Un panel de git tipo cafetería para VSCode.** Check, pull, commit, push, cambio de rama y estado de tus repos — sin stagear archivo por archivo ni pelearte con diffs. Funciona sobre **cualquier** proyecto que detecte, no uno solo.

Brew es una **alternativa simplificada al Source Control** de VSCode: enfocada en lo esencial, multi-repo, y con un asistente que te dice en cristiano qué botón conviene apretar.

---

## Qué hace

- **Auto-detecta proyectos** escaneando `gitArcade.rootPath` (y carpetas extra) en busca de repos `.git`.
- **Agrupa por carpeta**: los repos hermanos (ej. `Fidelya-backend` + `Fidelya-frontend`) forman un mismo proyecto y las acciones se aplican a todos a la vez.
- **Estado por repo**: rama actual, ahead/behind vs. remoto, nº de cambios y lista desplegable de archivos modificados (solo lectura).
- **Asistente**: lee el estado real y te sugiere el próximo paso — detecta ramas ya fusionadas, "ahead fantasma" (commits que ya viven en el remoto), ramas sin upstream, etc., para que no hagas un Push de más ni un Publish equivocado.

### Botones

| Botón | Qué hace |
|---|---|
| **Check** ✓ | `git fetch --all --prune` y cuenta commits pendientes. No modifica nada. |
| **Pull** ↓ | `git pull origin <rama> --no-rebase`. Omite repos con cambios sin commitear y aborta ante conflicto. |
| **Commit** ● | `git add -A` + commit con tu mensaje. |
| **Push** ↑ | `git push` (crea el upstream si falta). Detecta problemas de credenciales o remoto adelantado. |
| **✨ Sugerir** | Analiza el diff y **propone un mensaje de commit** (tipo, scope y viñetas por archivo; respeta Conventional Commits si el repo ya los usa). |
| **+** | Crea una rama nueva en todos los repos del proyecto. |
| **⌂ Ir a main** | Vuelve a la rama principal (solo aparece cuando estás fuera de ella y es seguro volver). |

---

## Sincronización con VSCode

Brew se mantiene alineado con el editor y la terminal en ambos sentidos:

- **Brew → VSCode/terminal**: al cambiar de rama hace un `git checkout` real (la terminal ya queda alineada) y fuerza `git.refresh` para que el indicador de rama nativo se actualice al instante.
- **Elegir un proyecto en el dropdown** abre su carpeta como workspace en VSCode (`vscode.openFolder`); si ya está abierta, solo refresca.
- **VSCode/terminal → Brew**: un `fs.watch` sobre `.git/HEAD` de cada repo detecta cambios de rama hechos por fuera y refresca el estado solo.
- **Auto-seleccionar**: al enfocar una carpeta o archivo en VSCode, Brew selecciona el proyecto correspondiente.

---

## Uso

1. Recarga VSCode (`Ctrl+Shift+P` → *Developer: Reload Window*).
2. Abre Brew: clic en **☕ Brew** (barra de estado, abajo) o en el icono de la barra de actividades. También `Ctrl+Shift+P` → *GIT ARCADE: Abrir widget*.
3. Elige un proyecto en el dropdown y presiona un botón.

Es una **vista fijable**: arrástrala a la barra lateral secundaria (derecha) o al panel inferior para anclarla pequeña. En VSCode ≥ 1.85 también puedes moverla a una **ventana flotante** para tenerla siempre encima.

---

## Configuración

| Ajuste | Default | Descripción |
|---|---|---|
| `gitArcade.rootPath` | `Documents\PROJECTS` | Carpeta raíz principal a escanear. |
| `gitArcade.extraPaths` | `[ Documents ]` | Carpetas adicionales a escanear (ej. donde clonas repos sueltos). |
| `gitArcade.scanDepth` | `4` | Profundidad máxima de carpetas a escanear. |
| `gitArcade.mainBranch` | `""` (auto) | Rama a integrar. Vacío = auto-detectar (`origin/HEAD` → `main` → `master`). |

Tras crear un proyecto nuevo, ejecuta `Ctrl+Shift+P` → *GIT ARCADE: Re-escanear proyectos*.

---

## Instalación

Copia `package.json` + `extension.js` + la carpeta `media/` a:

```
%USERPROFILE%\.vscode\extensions\git-arcade\
```

y recarga la ventana de VSCode (*Developer: Reload Window*).

### Comandos disponibles

- `GIT ARCADE: Abrir widget`
- `GIT ARCADE: Re-escanear proyectos`
- `GIT ARCADE: Abrir en ventana flotante`

---

Hecho por [@nikolas](https://github.com/nikolas). ☕
</content>
</invoke>
