import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const site = 'https://abdelhakim-baalla.github.io/fathom-lidar/'
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const guides = [
  {
    slug: 'lidar-point-cloud', title: 'LiDAR Point Cloud Viewer & Simulator',
    description: 'Inspect LiDAR point clouds in Fathom: tune simulated beam layouts, explore range and intensity, track objects, and replay captured sensor frames.',
    intro: 'Explore how a spinning LiDAR measures a scene. Fathom turns sensor frames into an interactive point cloud with range rings, return intensity, object tracks and recording controls.',
    sections: [
      ['Start without hardware', '<p>Open the console and choose <strong>Explore simulation</strong>. The city drive computes returns by casting rays from a modelled spinning sensor. Beam count, rotation rate, range noise, dropout and weather affect the measurements. The source is explicitly labelled as a simulation.</p><p>Use Chase, Plan or Side to change the view. Drag the point cloud to orbit and scroll to zoom. The arrow keys also orbit; keys 1, 2 and 3 select the camera views. Space pauses or resumes the active scan when a form control is not focused.</p>'],
      ['Read the point cloud', '<p>Range colouring separates near and far returns. Intensity shows return strength and highlights retroreflectors. Height colours distinguish road-level points from elevated structures. Channel colouring alternates beam rings. Ground truth is available only in simulation, where the scene classes are known.</p><p>Increasing the revolutions held leaves more past points visible. Moving objects can leave trails because the display accumulates measurements over time. These trails are history, not additional objects.</p>'],
      ['Object tracks and proximity', '<p>The perception pipeline removes ground, clusters returns and tracks candidate objects between frames. Object classes are heuristic. Confirmed tracks enter the observation log after eight observations. Select a log row to inspect the corresponding track.</p><p>Enable Proximity and set a radius to report confirmed tracks that enter that distance. An orange notice and optional warning cue accompany the event. Simulation and replay remain labelled. Proximity measures distance; it does not classify a person or object as a threat.</p>'],
      ['Connect a LiDAR', '<p>The Python bridge supports Velodyne VLP-16 UDP packets and the FTHM frame protocol. Run <code>uv run fathom-bridge --source udp</code> from the bridge directory, then choose Connected device in the console. An HTTPS console requires a trusted WSS endpoint. See the <a href="../about.html">hardware setup instructions</a> for certificate and origin configuration.</p><p>The code has protocol tests, but physical-device validation is still outstanding. Check dimensions, timestamps and packet rates against your own device before interpreting a capture.</p>'],
      ['Record and review', '<p>Record saves point-cloud frames into a local <code>.fthm</code> file. Stop and seal closes the recording and computes its SHA-256 checksum. Reopen it through Recording file and scrub the timeline. Export log produces a separate JSON observation report. A checksum supports integrity comparisons; it does not certify where a recording came from.</p>'],
    ],
    anchor: '',
  },
  {
    slug: 'esp32-wifi-csi', title: 'ESP32 Wi-Fi CSI Motion Sensing',
    description: 'Connect an ESP32 to Fathom over USB or a local bridge. View Wi-Fi CSI subcarrier amplitudes, calibrate the quiet floor, and inspect motion events.',
    intro: 'Wi-Fi channel state information describes how a radio signal changes across subcarriers. Fathom visualizes those measurements and detects changes consistent with motion near a radio link.',
    sections: [
      ['What you need', '<p>Use an ESP32 running compatible Espressif esp-csi firmware. Ordinary browser access to a router does not expose CSI. The console cannot use a laptop Wi-Fi connection alone to reconstruct a room or scan through walls.</p><p>For a visual demonstration without a board, open Wi-Fi and select Simulation. It models a transmitter and receiver with direct and reflected paths. The people setting changes that model; it is not a measured people count.</p>'],
      ['Connect over USB', '<p>Open Fathom on HTTPS or localhost in a browser that supports Web Serial, such as desktop Chrome or Edge. Select Wi-Fi, choose USB ESP32, then select your board from the browser device picker. The serial reader expects compatible esp-csi output at 921600 baud.</p><p>If no measurements arrive, check the firmware, serial permissions and cable. A connected port alone does not mean CSI packets are arriving. The packets-per-second readout distinguishes an open connection from measured input.</p>'],
      ['Connect through the bridge', '<p>Alternatively, install the bridge CSI extra with <code>uv sync --extra csi</code> and run <code>uv run fathom-bridge --csi-serial /dev/ttyUSB0</code>. Replace the device path with your board’s serial port. Select Bridge in the Wi-Fi controls and enter its WebSocket address.</p><p>Remote HTTPS pages require a trusted WSS connection. Read the <a href="../about.html">bridge setup</a> before connecting. Use a trusted network and configure the allowed console origin.</p>'],
      ['Interpret the spectrum', '<p>The display shows measured subcarrier amplitudes and a motion score. The detector compares channel changes with a quiet baseline. Received power is shown in dBm, while the packet rate reports how much CSI input is arriving.</p><p>A single link cannot reliably determine how many people are present, where they stand or what the room looks like. Interference, placement and environmental changes can affect the signal. Establish a quiet baseline and validate the response with known movements in the actual room.</p>'],
      ['Review motion events', '<p>Motion events appear in the observation log with their source. Filter by Wi-Fi to review them, or export the session log as JSON. Optional audio cues acknowledge an event; they are designed interface sounds and do not represent captured audio from the room.</p>'],
    ], anchor: '#wifi',
  },
  {
    slug: 'acoustic-spectrum', title: 'Live Microphone Spectrogram & Sound Events',
    description: 'Use Fathom to view a live microphone spectrogram, relative dBFS levels and estimated sound events, with local processing and optional stereo bearing.',
    intro: 'See how a sound changes over time. Fathom plots the microphone spectrum, tracks relative levels and logs likely sound events for inspection.',
    sections: [
      ['Start listening', '<p>Open the Acoustic feed and choose Enable microphone. The browser asks for microphone permission. Use HTTPS or localhost, and choose the input device in your browser or system settings. The console starts listening only after you enable it.</p><p>If permission is denied, enable microphone access for the site in the browser settings and try again. Check that the selected microphone is connected and not muted. No spectrum is displayed as live until microphone input is active.</p>'],
      ['Read the spectrogram', '<p>The spectrogram shows frequency content across time. Brighter areas indicate stronger energy. A steady pitch leaves a narrow band, while short broadband events spread across many frequencies. The level readout uses dBFS, relative to the audio converter’s full scale.</p><p>dBFS is not calibrated sound pressure in dB SPL. Microphone gain, distance, hardware and automatic processing all affect the measurement. Use the view to compare events within a session rather than as a calibrated environmental noise meter.</p>'],
      ['Estimated event classes', '<p>The detector opens an event when its level rises 12 dB above the estimated room noise floor and the spectrum changes. Duration, brightness and pitch inform a likely class. These labels are heuristics, not verified identifications.</p><p>With suitable stereo input, a timing difference between the channels can estimate left or right bearing. Configure the microphone spacing to match the physical pair. Two microphones cannot resolve front from back, and mono input does not provide stereo direction.</p>'],
      ['Interface audio and the microphone', '<p>Interface cues can enter the microphone through speakers. Fathom briefly suppresses event detection while its own cues play, reducing self-triggered observations. Headphones can further reduce this interference. The Audio control lets you mute cues, change their volume or preview individual sounds.</p><p>Custom intro, scanning and warning files are decoded locally for the current session. They replace interface cues; they are not inserted into the microphone signal or presented as detected sound.</p>'],
      ['Review observations', '<p>Choose Sound in the log filters to inspect acoustic events. Export log saves the observations as JSON. The point-cloud recording control records spatial frames, not raw microphone audio. Turn off microphone listening when your session ends.</p>'],
    ], anchor: '#acoustic',
  },
  {
    slug: 'phone-depth-scanning', title: 'Phone Room Scanning with WebXR Depth',
    description: 'Build a room point cloud with Fathom and a compatible Android ARCore phone. Learn WebXR depth requirements, scan controls and measurement limits.',
    intro: 'Fathom can accumulate a point cloud from phone depth frames and tracked camera poses. This path requires a phone and browser that support WebXR depth sensing.',
    sections: [
      ['Check compatibility', '<p>Use a compatible Android phone with ARCore depth support and a browser that exposes the required WebXR depth API. The page must run over HTTPS. A camera permission alone does not provide depth sensing, and availability varies by device and browser.</p><p>The console checks for an immersive AR session. Actual depth access is requested when the session starts, so an AR-capable device can still fail to provide the required depth stream. Read the returned error if the scan cannot start.</p>'],
      ['Start a local development session', '<p>From the console directory, run <code>bun run dev:phone</code> and open the printed network address on the phone. The development server uses HTTPS and can proxy the local bridge under <code>/bridge</code>. Configure a certificate trusted by your device for a reliable setup.</p><p>For a desktop view, connect through the bridge and enable the option to send the scan to it. Both clients must reach the same bridge. See the <a href="../about.html">hardware and connection guide</a> for endpoint requirements.</p>'],
      ['Capture the room', '<p>Choose Scan this room and allow the requested AR camera access. Move slowly while sweeping across the floor, walls and furniture. The scanner combines depth measurements with the tracked phone pose and keeps accumulated points.</p><p>Finish scan ends the AR session. Inspect the captured cloud using the console views. The spatial recording controls and observation log serve different purposes: the cloud contains geometry, while the log contains session events.</p>'],
      ['Understand depth limits', '<p>On most supported phones, ARCore depth is estimated. Reflective, transparent or low-texture surfaces can produce sparse or inaccurate measurements. Fast motion, tracking drift and poor lighting can also degrade the reconstruction.</p><p>A phone scan is not equivalent to a calibrated surveying LiDAR. The project has automated protocol and geometry tests, but physical phone validation remains outstanding. Compare a scan against known dimensions before using it for measurements.</p>'],
    ], anchor: '',
  },
]

mkdirSync(resolve(root, 'public/guides'), { recursive: true })
for (const guide of guides) {
  const url = `${site}guides/${guide.slug}.html`
  const graph = {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'TechArticle', '@id': `${url}#article`, headline: guide.title, description: guide.description, url, inLanguage: 'en', author: { '@type': 'Person', name: 'Abdelhakim Baalla', url: 'https://github.com/Abdelhakim-Baalla' }, isPartOf: { '@id': `${site}#website` }, mainEntityOfPage: url },
      { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Fathom', item: site }, { '@type': 'ListItem', position: 2, name: 'Guides', item: `${site}about.html#guides` }, { '@type': 'ListItem', position: 3, name: guide.title, item: url }] },
    ],
  }
  const toc = guide.sections.map(([title], i) => `<li><a href="#section-${i + 1}">${title}</a></li>`).join('')
  const sections = guide.sections.map(([title, content], i) => `<section aria-labelledby="section-${i + 1}"><h2 id="section-${i + 1}">${title}</h2>${content}</section>`).join('\n')
  writeFileSync(resolve(root, `public/guides/${guide.slug}.html`), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(guide.title)} — Fathom</title><meta name="description" content="${escape(guide.description)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#101114">
<link rel="canonical" href="${url}"><link rel="icon" href="../favicon.svg"><link rel="stylesheet" href="./guide.css">
<meta property="og:type" content="article"><meta property="og:site_name" content="Fathom Field Systems"><meta property="og:title" content="${escape(guide.title)} — Fathom"><meta property="og:description" content="${escape(guide.description)}"><meta property="og:url" content="${url}"><meta property="og:locale" content="en_US"><meta property="og:image" content="${site}social-preview.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Fathom Field Systems — spatial, radio and acoustic observation">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(guide.title)} — Fathom"><meta name="twitter:description" content="${escape(guide.description)}"><meta name="twitter:image" content="${site}social-preview.png"><meta name="twitter:image:alt" content="Fathom Field Systems">
<script type="application/ld+json">${JSON.stringify(graph).replaceAll('<', '\\u003c')}</script></head>
<body><a class="skip" href="#content">Skip to guide</a><header><a href="../" aria-label="Fathom console"><img src="../identity/fathom-lockup.svg" alt="Fathom Field Systems" width="176" height="40"></a><a href="../about.html#guides">All guides</a></header>
<main id="content"><h1>${guide.title}</h1><p class="lead">${guide.intro}</p><a class="launch" href="../${guide.anchor}">Open ${guide.anchor === '#wifi' ? 'Wi-Fi' : guide.anchor === '#acoustic' ? 'Acoustic' : 'Fathom'}</a><nav class="contents" aria-label="On this page"><h2>In this guide</h2><ol>${toc}</ol></nav>${sections}<nav class="related" aria-label="Related guides"><h2>Explore the other inputs</h2><ul>${guides.filter(other => other !== guide).map(other => `<li><a href="./${other.slug}.html">${other.title}</a></li>`).join('')}</ul></nav></main>
<footer><a href="../">Console</a><a href="../about.html">About &amp; hardware</a><a href="https://github.com/Abdelhakim-Baalla/fathom-lidar">Source code</a><span>Fathom / Field Systems</span></footer></body></html>\n`)
}
const urls = [site, `${site}about.html`, ...guides.map(guide => `${site}guides/${guide.slug}.html`)]
writeFileSync(resolve(root, 'public/sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(url => `  <url><loc>${url}</loc></url>`).join('\n')}\n</urlset>\n`)
// Validate the authored shell as well: malformed structured data must fail the build.
for (const path of ['index.html', 'public/about.html']) {
  const html = readFileSync(resolve(root, path), 'utf8')
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(match[1])
  if (!html.includes('rel="canonical"') || !html.includes('name="description"')) throw new Error(`Missing SEO metadata in ${path}`)
}
console.log(`Prepared ${guides.length} static guides and ${urls.length} sitemap URLs.`)
