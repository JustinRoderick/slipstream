let detector: any = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === "init") {
    const { wasmPath, modelPath } = payload;
    const mp = await import("@mediapipe/tasks-vision");
    const { FilesetResolver, FaceLandmarker } = mp;

    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    detector = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelPath },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

    self.postMessage({ type: "ready" });
  }

  if (type === "frame" && detector) {
    const { bitmap, timestamp } = payload;
    try {
      const res = detector.detectForVideo(bitmap, timestamp);
      self.postMessage({ type: "landmarks", payload: res.faceLandmarks });
    } finally {
      bitmap.close();
    }
  }
};
