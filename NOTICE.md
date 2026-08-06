# Notices

## Upstream project

This repository is based on [SatIdentifier](https://github.com/exoplanet5/SatIdentifier)
by Zhuoxiao. The upstream project and the modifications in this repository are
distributed under the MIT License; see [LICENSE](LICENSE). The upstream
copyright and license notice must remain with copies or substantial portions of
the software.

The maintained changes in this repository include satellite-occultation
planning and event-search features, native-window and headless execution paths,
and their associated tests and documentation.

## Third-party components

- [satellite.js](https://github.com/shashwatak/satellite-js) is vendored under
  `app/js/vendor/satellite.min.js` and is distributed under the MIT License.
- Star and Milky Way chart data derived from
  [d3-celestial](https://github.com/ofrohn/d3-celestial) are vendored under
  `app/js/vendor/starcat.js` and `app/js/vendor/mwdata.js`; those files retain
  their BSD-3-Clause attribution notices.
- Additional catalogue and astronomy-data sources are credited in the
  [README](README.md) and in the relevant source and documentation files.
