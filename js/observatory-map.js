let map, savedView, savedSelection;

export function disposeVehicleMap() {
  if (!map) return;
  savedView = { center: map.getCenter(), zoom: map.getZoom() };
  map.remove(); map = undefined;
}

export function renderVehicleMap(positions, selection, formatTime, sourceTime) {
  const target = document.getElementById('vehicleMap');
  const status = document.getElementById('mapStatus');
  const fit = document.getElementById('fitVehicles');
  const L = window.L;
  fit.disabled = !positions.length || !L;
  if (!L || !positions.length) {
    target.textContent = !L ? 'Map library unavailable. Vehicle coordinates remain available in the table below.' : 'No valid vehicle locations for this selection.';
    status.textContent = `Vehicle feed: ${formatTime(sourceTime)}.`;
    return;
  }
  map = L.map(target, { scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
  // Normal browser tile requests respect HTTP caching and send the site referrer.
  // Only tiles in the current viewport are loaded; no offline/prefetch feature.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
  }).on('tileerror', () => { status.textContent = 'Some street tiles could not load. Reported vehicle markers and the coordinate table remain available.'; }).addTo(map);
  const bounds = L.latLngBounds(positions.map(p => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [24,24], maxZoom: 14, animate: false });
  for (const p of positions) {
    const label = `Vehicle ${p.vehicle_id} · route ${p.route_key} · ${formatTime(p.observed_at)}`;
    const content = document.createElement('span'); content.textContent = label;
    const marker = L.circleMarker([p.lat, p.lon], { radius: 6, color: '#392719', weight: 2, fillColor: '#d1a67d', fillOpacity: 1 }).addTo(map).bindPopup(content);
    const element = marker.getElement();
    element.setAttribute('tabindex', '0'); element.setAttribute('role', 'button'); element.setAttribute('aria-label', label);
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); marker.openPopup(); }
    });
  }
  const fitBounds = () => map.fitBounds(bounds, { padding: [24,24], maxZoom: 14, animate: false });
  if (savedView && savedSelection === selection) map.setView(savedView.center, savedView.zoom, { animate: false });
  else fitBounds();
  savedSelection = selection;
  fit.onclick = fitBounds;
  L.control.scale({ imperial: true, metric: true }).addTo(map);
  status.textContent = `${positions.length} reported locations · vehicle feed ${formatTime(sourceTime)}. Street map by OpenStreetMap. Locations are snapshots; movement between observations is not inferred.`;
}
