# Changelog

Todos los cambios notables de este proyecto se documentan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [2.6.0] - 2026-07-24

### Añadido
- **Fondo del panel personalizable**: icono de imagen en la cabecera que abre un popover
  con un **slider de intensidad** y botones para **elegir una imagen** propia o **restaurar**
  la de por defecto.
- Comando *GIT ARCADE: Cambiar fondo del panel* con un menú y **vista previa en vivo** de la
  intensidad (Apagado → Visible), más *GIT ARCADE: Restaurar fondo por defecto*.
- Ajustes `gitArcade.backgroundImage` (ruta) y `gitArcade.backgroundOpacity` (0–1). El fondo se
  aplica en caliente y se sincroniza entre la vista fijada y la ventana flotante.
- Licencia **MIT** y este CHANGELOG.

### Cambiado
- La imagen de fondo por defecto se lee en tiempo de ejecución desde `media/background.jpg`
  (antes iba pre-embebida en un CSS generado de ~300 KB).

## [2.5.0] - 2026-07-24

### Añadido
- **Sugerencia de commit con IA**: usa el modelo del editor (VSCode Language Model API) si hay
  un proveedor instalado (Copilot, Claude, etc.), con **fallback** al generador heurístico offline.
- Verificación de identidad git (`user.name`/`user.email`) antes de commitear, con opción de
  configurarla al vuelo.

### Seguridad
- **CSP** en el webview (solo `data:` e inline) y escape de nombres de rama/repo en el estado y
  en el asistente.
- Al cancelar, se limpia un `.git/index.lock` huérfano tras matar un git a mitad de commit/pull.

### Cambiado
- Rendimiento: caché de la rama principal por repo e invalidación de proyectos con TTL (aparecen
  repos nuevos sin re-escaneo manual).

## [2.4.0] - 2026-07-24

### Añadido
- **Estado en vivo**: el panel refresca los cambios "sin commitear" al guardar, crear, borrar o
  renombrar archivos (desde VS Code o la terminal).
- **Ver diff**: clic en un archivo de la lista abre su diff nativo (HEAD ↔ tu versión).
- **Selección por repo**: en proyectos multi-repo, un checkbox por repo elige a cuáles aplicar
  Check / Pull / Commit / Push.

### Cambiado
- Rutas por defecto sin datos personales (`os.homedir()`), pensando en un repo público.

## [2.2.0] - 2026-07-04

### Añadido
- Sincronización bidireccional con VS Code: cambio de rama refleja `git.refresh`,
  `fs.watch` sobre `.git/HEAD` para cambios externos, y auto-selección de proyecto.
- Ventana flotante (popout) para mantener el panel siempre encima.
- Sugeridor de mensajes de commit basado en el diff real.
