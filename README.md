# Navigation for Meta Ray-Ban Display

A free, experimental driving guidance Web App for the 600 × 600 Meta Ray-Ban Display. It uses the paired phone's location, OpenStreetMap place search and map tiles, and the public Valhalla routing service. No account, API key, or payment method is required.

## Add to glasses

In the Meta AI phone app, add **Navigation** as a Web App connection using **https://vexd1.github.io/Navigation/**. Open it on the glasses to grant location permission. The same URL receives future updates.

## What it shows

- A large next-turn arrow, distance, road name, remaining distance, and ETA.
- A heading-up street map that zooms closer near turns. The white position arrow stays near the bottom centre; the road and route move beneath it. A ring marks the next maneuver.
- A mapped speed limit when the routing data and GPS match are good enough. The value can be missing or outdated; road signs take precedence.
- Lane guidance if the routing service supplies usable lane data for the upcoming turn. No lane is guessed from road type.

It cannot draw a line locked to the actual road seen through the lenses. A Web App has no documented road-alignment or spatial-anchor API. The line is on the **map**.

## Use

1. Open Navigation and choose **Use my location**. Grant location permission. The position comes from the paired phone.
2. Select **Enter destination postcode**, move between the on-screen letters and numbers, and pinch to add each character. Select **Find postcode** when complete. The space is added automatically. You can enter the postcode before location is ready; search starts when a clear fix arrives. There is no Listen field.
3. Select the postcode search result. Guidance opens automatically when the route is ready. Set the destination before driving.
4. **Route options** offers location retry, route refresh, or end guidance.

**Try a sample route** starts a simulated journey near Trafalgar Square without permission or network routing. It is labelled DEMO throughout guidance.

The Web App must stay open. It pauses guidance when GPS is stale or inaccurate, and it cannot guarantee continued updates when the glasses runtime is hidden or suspended. A missed turn triggers a limited reroute attempt. If the free routing service is unavailable, guidance pauses rather than inventing instructions. Check road signs and conditions for every maneuver.

## Data and service limits

Routes and maneuver text come from [Valhalla's public demo service](https://github.com/valhalla/valhalla#demo-server). It is free under fair usage but has no uptime or response-time guarantee. Speed limits come from its [trace attributes](https://valhalla.github.io/valhalla/api/map-matching/api-reference/) and may be missing. Place search uses [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) only on explicit submit, at most once per second. Street tiles follow [OpenStreetMap's tile usage policy](https://operations.osmfoundation.org/policies/tiles/) and are cached by the browser. Map data © OpenStreetMap contributors.

Destination searches go to Nominatim; a route request sends your current coordinates and destination to Valhalla; map tile requests reveal the viewed area to OpenStreetMap. The app has no server or analytics, and it does not save trip history.

This is a personal preview, not a dependable primary navigation system. Test the UI while stationary or as a passenger, then verify GPS updates, turn timing, and runtime behaviour on the actual glasses before relying on it.

## Development

Serve this folder over HTTP or HTTPS, then open at a 600 × 600 viewport. Chrome DevTools → Sensors can simulate GPS locations. The sample route works without GPS. The [Meta Display Simulator](https://github.com/facebook/meta-wearables-webapp) can check layout and D-pad controls; it cannot verify real GPS or driving reliability.
