# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: the user asked for a recommendation and added that other languages (C++, Python) are welcome so the project can connect to real hardware later.

- Console: Vite + TypeScript + React + three.js, custom GLSL point shaders, the ray caster in a Web Worker. Ships as a static site.
- Hardware bridge: a Python service that reads sensor UDP packets (or replays a capture) and forwards frames to the console over WebSocket in the same binary frame format the simulator emits. The console does not know whether a frame came from the simulator or a device.

## Users

Confirmed by the user as "all of this":

- Recruiters and reviewers judging engineering and design skill in a few minutes.
- Robotics and perception engineers who know LiDAR and want to explore sensor configurations.
- Students learning how a scanning LiDAR works.

## Product Purpose

A browser console for a scanning LiDAR. It physically simulates a spinning multi-beam sensor in a 3D scene, renders the live point cloud, detects and tracks objects, and lets the operator tune the sensor and see the effect immediately. Success: a newcomer understands what the sensor sees and why within a minute; an engineer finds the numbers and behaviour credible.

## Positioning

The point cloud is computed, not animated: every point is a ray cast from a modelled sensor (beam layout, rotation rate, range limits, noise, surface reflectivity). Changing a sensor parameter changes the physics, and the same frame protocol accepts a real device.

## Operating Context

Desktop browser, mouse and keyboard, a large viewport. Used for exploration and demonstration sessions of several minutes. Later: connected to a real sensor through the bridge on a local network.

## Capabilities and Constraints

- Simulated sensor with configurable channels, vertical field of view, rotation rate, range, range noise and dropout.
- Scene with static structure and moving objects.
- Point colouring by intensity, height, range, ring and object class.
- Ground removal, clustering, bounding boxes and tracking across frames.
- Recording and replay of frames.
- Hardware input through the bridge; first target protocol is the Velodyne VLP-16 data packet.
- No real hardware is available today: everything shown comes from the simulator and must be labelled as simulated.
- Undecided: additional sensor protocols (Ouster, Livox), ROS 2 integration, a C++ core.

## Evidence on Hand

None beyond the software itself. No customers, benchmarks, field data or hardware test results exist; future work must not invent them.

## Product Principles

1. Physically honest: nothing is drawn that the modelled sensor would not measure.
2. Simulated data is always labelled as simulated.
3. One frame protocol for simulator and hardware.
4. Every control shows its unit and its effect immediately.
5. Readable by a newcomer, credible to an expert.
