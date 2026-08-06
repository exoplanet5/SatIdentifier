# Notices

## Upstream project

This repository is based on [SatIdentifier](https://github.com/exoplanet5/SatIdentifier)
by Zhuoxiao. SatOccult is an independently maintained fork and is not an
official release of, affiliated with, or endorsed by the upstream project.
The upstream copyright and license notice are preserved in [LICENSE](LICENSE).
The MIT License applies to this distribution, including the modifications in
this repository, except where a file or third-party notice states otherwise.

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
