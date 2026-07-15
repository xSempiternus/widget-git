# Changelog

Todos los cambios notables de este proyecto se documentan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [2.3.0] - 2026-07-14

### Añadido
- **Fondo personalizable**: opción para usar cualquier imagen como fondo del panel
  (icono de imagen en la cabecera o comando *GIT ARCADE: Cambiar fondo del panel*).
- Ajuste `gitArcade.backgroundImage` (ruta) y `gitArcade.backgroundOpacity` (0–1) para
  controlar imagen e intensidad. El fondo se aplica en caliente, sin recargar.
- Fondo de cafetería por defecto, muy sutil, con velo cálido para no restar legibilidad.
- Iconos de **actualizar estado** y **re-escanear** en la cabecera.
- Estado **hecho** (verde con ✓) en cada botón al completar su acción.
- Licencia MIT, metadatos del paquete (repository, keywords) y este CHANGELOG.

### Cambiado
- Tipografía e interletraje unificados (paleta cálida, más suave).
- Botones con un **lenguaje de degradado** común (ámbar/café), con estados base/hover/hecho.
- La imagen de fondo se lee en tiempo de ejecución desde `media/` (antes iba pre-embebida
  en un CSS generado).

### Eliminado
- Notas internas de trabajo y binarios del control de versiones (`.gitignore`).

## [2.2.0] - 2026-07-04

### Añadido
- Sincronización bidireccional con VS Code: cambio de rama refleja `git.refresh`,
  `fs.watch` sobre `.git/HEAD` para cambios externos, y auto-selección de proyecto.
- Ventana flotante (popout) para mantener el panel siempre encima.
- Sugeridor de mensajes de commit basado en el diff real.
