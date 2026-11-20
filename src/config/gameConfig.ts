// Central tuning values. Tweak gameplay here without touching logic files.
export const GAME_CONFIG = {
  room: {
    width: 16, // X axis (meters)
    depth: 12, // Z axis (meters)
    height: 4,
    wallThickness: 0.2,
  },

  player: {
    radius: 0.35, // collision circle radius
    walkSpeed: 2.4, // m/s
    runSpeed: 5.0, // m/s (Shift)
    backwardFactor: 0.6,
    turnSpeed: 2.7, // rad/s
    spawn: { x: 0, y: 0, z: 3.4, rotationY: Math.PI }, // facing the desk
  },

  camera: {
    fov: 60,
    distance: 4.2, // behind the agent
    height: 2.15,
    lookAtHeight: 1.45,
    followSmoothing: 6.5, // exponential damping factor
    wallMargin: 0.3, // keep camera inside the room
  },

  animation: {
    walkFrequency: 7.6, // rad/s of the procedural gait phase
    runFrequency: 11.6,
    blendSpeed: 12, // idle <-> walk <-> run smoothing
  },

  render: {
    maxPixelRatio: 1.5,
    shadowMapSize: 1024,
  },

  character: {
    detail: 1.5,
    modelUrl: './assets/agentsmith.glb',
    modelHeight: 1.87,
    modelYawOffset: 0, // degrees (-180..180)
    // Procedural limb deformation for static (unrigged) scans.
    deform: {
      enabled: true,
      swing: 1.0,
      arm: 1.0,
      knee: 0.9,
      twist: 0.11,
      sway: 1.35,
      lean: 0.9,
      bob: 0.6,
    },
    fbxIdle: '',
    fbxWalk: '',
    fbxRun: '',
    textureUrl: '',
  },

  mission: {
    intelSpots: [
      [-6.2, -1.2],
      [-5.0, 4.2],
      [5.6, -4.4],
      [6.4, 4.6],
      [-2.6, -5.0],
      [3.2, 0.4],
      [-6.8, 2.6],
      [2.2, -5.2],
    ] as ReadonlyArray<readonly [number, number]>,
    exit: { x: 7.0, z: 3.7, radius: 1.05 },
    pickupRadius: 0.85,
    camera: { x: 0, y: 3.25, z: -5.55, range: 1.02, halfAngle: 0.36, reach: 9.5 },
    levels: [
      { name: 'RECRUIT', intel: 4, time: 150, sweep: 0.34, detect: 22 },
      { name: 'AGENT', intel: 5, time: 120, sweep: 0.50, detect: 30 },
      { name: 'PHANTOM', intel: 6, time: 95, sweep: 0.68, detect: 40 },
    ],
    sprintNoise: 2.2,
    stillFactor: 0.45,
    decay: 19,
  },

  network: {
    enabled: false,
    tickRate: 10,
    channelName: 'spy-office:room-01',
    supabaseUrl: 'YOUR_SUPABASE_URL',
    supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
  },
} as const;
