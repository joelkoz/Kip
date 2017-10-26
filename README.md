# Kip

This is an instrumentation package to display signalK data. Display can be split up in any arrangement to show all data available on the server.

## Design Goal

The idea is to replicate the functionality of your average MFD such as the B&G Triton, Raymarine i70, or Garmin GMI20. Display should be fullscreen and not require any scrolling, and anything displayed should be as big as possible in the given space. Multiple pages

## Developing

The app is an Angular-cli app. Install dependencies with `npm install`. Then run `ng serve` for a dev server. Navigate to `http://localhost:4200/`. The app will automatically reload if you change any of the source files. Run `ng build` to build the project. The build artifacts will be stored in the `public/` directory. Use the `-prod` flag for a production build. To prepare for npm, run `npm run-script build-npm`.



## Todo List

### V0.1
* Derived Data - Done
* Sailgauge (True wind) - Done!
* Demo default config - Done!
* Load/Save Config - Done!
* Get a few themes going - Done!

### V0.2
* Sailgauge Laylines and sectors
* Tutorial Widget
* Customization options for radial/linear Gauges
* Customization options for Historical Charts
* Pre-created widgets for commonly used displays
* Redo conversion service
  * Know at least which type of unit it should be. (either with meta or hard coded/derived from schema)
  * Default unit for each unit type in config.
* Show SignalK status/alert if disconnected
* Radial/Linear Gauge Zones

### V0.3
 * Sailing Polars with ChartJS Radar type chart?
 * Alerts/Notifications
 * iFrame Widget?
 