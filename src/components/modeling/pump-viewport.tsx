"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { pointDistanceMillimeters } from "@/lib/modeling/client/measurement";
import {
  V1_VANE_COUNT,
  type ModelingDocumentKind,
  type ModelingTool,
  type PumpDocument,
  type PumpPart
} from "@/lib/modeling/client/workspace-state";
import type { ModelDocument } from "@/types/modeling";
import styles from "./modeling-workspace.module.css";

type ViewportProps = {
  document: PumpDocument;
  documentKind: ModelingDocumentKind;
  modelDocument: ModelDocument;
  selectedPartId: string;
  selectedSemanticIds: string[];
  errorSemanticIds: string[];
  hiddenSemanticIds: string[];
  isolatedSemanticId?: string;
  activeTool: ModelingTool;
  previewUrl?: string;
  onSelectPart: (partId: string) => void;
  onMeasurementChange?: (
    measurement:
      | { status: "awaiting-second-point" }
      | { status: "complete"; distanceMm: number }
      | undefined
  ) => void;
};

type SceneState = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  pumpRoot: THREE.Group;
  raycaster: THREE.Raycaster;
  grid: THREE.GridHelper;
};

const BODY_COLOR = 0x8f9697;
const DARK_METAL = 0x353a3b;
const TEAL = 0x11948d;
const SELECTION = 0x20b8ad;

export default function PumpViewport({
  document,
  documentKind,
  modelDocument,
  selectedPartId,
  selectedSemanticIds,
  errorSemanticIds,
  hiddenSemanticIds,
  isolatedSemanticId,
  activeTool,
  previewUrl,
  onSelectPart,
  onMeasurementChange
}: ViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | undefined>(undefined);
  const selectRef = useRef(onSelectPart);
  const measurementCallbackRef = useRef(onMeasurementChange);
  const measurementPointsRef = useRef<THREE.Vector3[]>([]);
  const renderInputsRef = useRef({
    document,
    documentKind,
    modelDocument,
    selectedPartId,
    selectedSemanticIds,
    errorSemanticIds,
    hiddenSemanticIds,
    isolatedSemanticId,
    activeTool,
    previewUrl
  });
  const [renderError, setRenderError] = useState<"webgl" | "preview">();

  useEffect(() => {
    selectRef.current = onSelectPart;
  }, [onSelectPart]);

  useEffect(() => {
    measurementCallbackRef.current = onMeasurementChange;
  }, [onMeasurementChange]);

  useEffect(() => {
    renderInputsRef.current = {
      document,
      documentKind,
      modelDocument,
      selectedPartId,
      selectedSemanticIds,
      errorSemanticIds,
      hiddenSemanticIds,
      isolatedSemanticId,
      activeTool,
      previewUrl
    };
  }, [
    activeTool,
    document,
    documentKind,
    errorSemanticIds,
    hiddenSemanticIds,
    isolatedSemanticId,
    modelDocument,
    selectedPartId,
    selectedSemanticIds,
    previewUrl
  ]);

  useEffect(() => {
    measurementPointsRef.current = [];
    measurementCallbackRef.current?.(undefined);
  }, [activeTool, previewUrl]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      const timer = window.setTimeout(() => setRenderError("webgl"), 0);
      return () => window.clearTimeout(timer);
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(
      Math.max(host.clientWidth, 1),
      Math.max(host.clientHeight, 1)
    );
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf9fbfa);
    scene.fog = new THREE.Fog(0xf9fbfa, 14, 24);

    const camera = new THREE.PerspectiveCamera(
      32,
      Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1),
      0.1,
      60
    );
    camera.position.set(-6.8, 4.7, 10.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.minDistance = 4.8;
    controls.maxDistance = 18;
    controls.target.set(0, 0.15, 0);
    controls.update();

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0xb7c1bd, 2.25);
    scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffffff, 4.2);
    key.position.set(4, 7, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9edbd5, 1.3);
    rim.position.set(-6, 1, -4);
    scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.ShadowMaterial({ color: 0x66827d, opacity: 0.12 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.62;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(18, 36, 0xdfe6e4, 0xebefee);
    grid.position.y = -2.61;
    const gridMaterials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    gridMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.48;
    });
    scene.add(grid);

    const axes = new THREE.AxesHelper(1.15);
    axes.position.set(-3.65, -2.35, 1.55);
    scene.add(axes);

    const pumpRoot = new THREE.Group();
    pumpRoot.rotation.x = -0.04;
    pumpRoot.rotation.y = -0.08;
    scene.add(pumpRoot);

    const raycaster = new THREE.Raycaster();
    const state: SceneState = {
      scene,
      camera,
      renderer,
      controls,
      pumpRoot,
      raycaster,
      grid
    };
    sceneRef.current = state;

    let pointerDownX = 0;
    let pointerDownY = 0;
    const handlePointerDown = (event: PointerEvent) => {
      pointerDownX = event.clientX;
      pointerDownY = event.clientY;
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (
        Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY) >
        5
      ) {
        return;
      }
      const bounds = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1
      );
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(pumpRoot.children, true);
      if (
        renderInputsRef.current.activeTool === "measure" &&
        renderInputsRef.current.previewUrl
      ) {
        const measuredHit = intersections.find(
          (intersection) =>
            intersection.object instanceof THREE.Mesh &&
            !intersection.object.userData.decorative
        );
        if (!measuredHit) return;
        const points = measurementPointsRef.current;
        if (points.length === 0) {
          measurementPointsRef.current = [measuredHit.point.clone()];
          measurementCallbackRef.current?.({
            status: "awaiting-second-point"
          });
          return;
        }
        const millimetersPerWorldUnit = Number(
          pumpRoot.userData.openvacMillimetersPerWorldUnit
        );
        if (
          !Number.isFinite(millimetersPerWorldUnit) ||
          millimetersPerWorldUnit <= 0
        ) {
          measurementPointsRef.current = [];
          measurementCallbackRef.current?.(undefined);
          return;
        }
        const distanceMm = pointDistanceMillimeters(
          [points[0]!.x, points[0]!.y, points[0]!.z],
          [measuredHit.point.x, measuredHit.point.y, measuredHit.point.z],
          millimetersPerWorldUnit
        );
        measurementPointsRef.current = [];
        measurementCallbackRef.current?.({ status: "complete", distanceMm });
        return;
      }
      const hit = intersections.find((intersection) =>
        findPartId(intersection.object)
      );
      const partId = hit ? findPartId(hit.object) : undefined;
      if (partId) selectRef.current(partId);
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);

    let alternateBackground = false;
    const handleViewCommand = (event: Event) => {
      const command = (event as CustomEvent<{ command?: string }>).detail
        ?.command;
      if (command === "grid") {
        grid.visible = !grid.visible;
        return;
      }
      if (command === "background") {
        alternateBackground = !alternateBackground;
        scene.background = new THREE.Color(
          alternateBackground ? 0xf1f5f4 : 0xf9fbfa
        );
        return;
      }
      if (command === "fit") {
        camera.position.set(0, 0.45, 11.8);
      } else {
        camera.position.set(-6.8, 4.7, 10.5);
      }
      controls.target.set(0, 0.15, 0);
      controls.update();
    };
    window.addEventListener("openvac:modeling-view", handleViewCommand);

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("openvac:modeling-view", handleViewCommand);
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || previewUrl) return;
    disposeObject(state.pumpRoot);
    state.pumpRoot.clear();
    if (documentKind === "pump-template") {
      buildRotaryVanePump(state.pumpRoot, document, selectedPartId, activeTool);
    }
  }, [activeTool, document, documentKind, previewUrl, selectedPartId]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !previewUrl) return;
    let cancelled = false;
    const loader = new GLTFLoader();
    loader.load(
      previewUrl,
      (gltf) => {
        if (cancelled) {
          disposeObject(gltf.scene);
          return;
        }
        disposeObject(state.pumpRoot);
        state.pumpRoot.clear();
        prepareKernelPreview(gltf.scene, documentKind, modelDocument);
        state.pumpRoot.add(gltf.scene);
        state.pumpRoot.userData.openvacMillimetersPerWorldUnit =
          fitKernelPreview(gltf.scene);
        applyKernelSelection(
          state.pumpRoot,
          currentSelectionIds(renderInputsRef.current),
          renderInputsRef.current.errorSemanticIds
        );
        applyKernelVisibility(
          state.pumpRoot,
          renderInputsRef.current.hiddenSemanticIds,
          renderInputsRef.current.isolatedSemanticId
        );
        applyKernelSection(
          state.pumpRoot,
          renderInputsRef.current.activeTool === "section"
        );
      },
      undefined,
      () => {
        if (cancelled) return;
        disposeObject(state.pumpRoot);
        state.pumpRoot.clear();
        if (renderInputsRef.current.documentKind === "pump-template") {
          buildRotaryVanePump(
            state.pumpRoot,
            renderInputsRef.current.document,
            renderInputsRef.current.selectedPartId,
            renderInputsRef.current.activeTool
          );
        } else {
          setRenderError("preview");
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [documentKind, modelDocument, previewUrl]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !previewUrl) return;
    applyKernelSelection(
      state.pumpRoot,
      documentKind === "pump-template" ? [selectedPartId] : selectedSemanticIds,
      errorSemanticIds
    );
    applyKernelSection(state.pumpRoot, activeTool === "section");
    applyKernelVisibility(
      state.pumpRoot,
      hiddenSemanticIds,
      isolatedSemanticId
    );
  }, [
    activeTool,
    documentKind,
    errorSemanticIds,
    hiddenSemanticIds,
    isolatedSemanticId,
    previewUrl,
    selectedPartId,
    selectedSemanticIds
  ]);

  if (renderError) {
    return (
      <div className={styles.viewportUnavailable} role="status">
        <div aria-hidden>3D</div>
        <strong>
          {renderError === "webgl"
            ? "当前浏览器无法启动 WebGL"
            : "权威 GLB 预览载入失败"}
        </strong>
        <span>
          {renderError === "webgl"
            ? "参数仍可编辑；请启用硬件加速后查看 Three.js 模型。"
            : "已清空画布，不会回退显示旋片泵或其他伪几何。"}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className={styles.threeHost}
      aria-label={
        documentKind === "pump-template"
          ? "旋片真空泵三维视图"
          : "通用零件权威 GLB 三维视图"
      }
    />
  );
}

const KERNEL_PART_NAMES: Array<[string, string]> = [
  ["pump-housing", "pump-body"],
  ["eccentric-rotor", "eccentric-rotor"],
  ["front-cover", "front-cover"],
  ["rear-cover", "back-cover"],
  ["back-cover", "back-cover"],
  ["shaft", "main-shaft"],
  ["vane-1", "vane-1"],
  ["vane-2", "vane-2"]
];

function prepareKernelPreview(
  scene: THREE.Object3D,
  documentKind: ModelingDocumentKind,
  document: ModelDocument
) {
  const componentRefs = new Set(
    document.components.map((component) => component.semanticRef)
  );
  const featureRefs = new Set(
    document.features.map((feature) => feature.semanticRef)
  );
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const partId =
      documentKind === "pump-template"
        ? kernelPartId(object)
        : generalObjectId(object, componentRefs, featureRefs);
    if (partId) object.userData.partId = partId;
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => material.clone())
      : object.material.clone();
    forEachMaterial(object.material, (material) => {
      if ("color" in material && material.color instanceof THREE.Color) {
        material.userData.openvacBaseColor = material.color.getHex();
      }
    });
  });
}

function fitKernelPreview(scene: THREE.Object3D) {
  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(largest) || largest <= 0) return undefined;
  const scale = 6 / largest;
  scene.scale.setScalar(scale);
  scene.position.set(
    -center.x * scale,
    -center.y * scale - 0.1,
    -center.z * scale
  );
  return 1 / scale;
}

function applyKernelSelection(
  root: THREE.Object3D,
  selectedPartIds: readonly string[],
  errorPartIds: readonly string[]
) {
  const selected = new Set(selectedPartIds);
  const errors = new Set(errorPartIds);
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    forEachMaterial(object.material, (material) => {
      if (!("color" in material) || !(material.color instanceof THREE.Color)) {
        return;
      }
      const base = material.userData.openvacBaseColor;
      if (typeof base === "number") material.color.setHex(base);
      if (errors.has(String(object.userData.partId))) {
        material.color.setHex(0xd84c3f);
      } else if (selected.has(String(object.userData.partId))) {
        material.color.setHex(SELECTION);
      }
    });
  });
}

function applyKernelSection(root: THREE.Object3D, enabled: boolean) {
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    forEachMaterial(object.material, (material) => {
      material.clippingPlanes = enabled ? [plane] : null;
      material.clipShadows = enabled;
      material.needsUpdate = true;
    });
  });
}

function applyKernelVisibility(
  root: THREE.Object3D,
  hiddenPartIds: readonly string[],
  isolatedPartId?: string
) {
  const hidden = new Set(hiddenPartIds);
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const partId = String(object.userData.partId ?? "");
    object.visible = isolatedPartId
      ? partId === isolatedPartId
      : !hidden.has(partId);
  });
}

function kernelPartId(object: THREE.Object3D): string | undefined {
  let current: THREE.Object3D | null = object;
  while (current) {
    const name = current.name.toLowerCase();
    const match = KERNEL_PART_NAMES.find(([kernelName]) =>
      name.includes(kernelName)
    );
    if (match) return match[1];
    current = current.parent;
  }
}

function generalObjectId(
  object: THREE.Object3D,
  componentRefs: ReadonlySet<string>,
  featureRefs: ReadonlySet<string>
) {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (componentRefs.has(current.name)) return `component:${current.name}`;
    if (featureRefs.has(current.name)) return `feature:${current.name}`;
    current = current.parent;
  }
}

function currentSelectionIds(inputs: {
  documentKind: ModelingDocumentKind;
  selectedPartId: string;
  selectedSemanticIds: string[];
  errorSemanticIds: string[];
}) {
  return inputs.documentKind === "pump-template"
    ? [inputs.selectedPartId]
    : inputs.selectedSemanticIds;
}

function forEachMaterial(
  material: THREE.Material | THREE.Material[],
  callback: (item: THREE.Material) => void
) {
  (Array.isArray(material) ? material : [material]).forEach(callback);
}

function buildRotaryVanePump(
  root: THREE.Group,
  document: PumpDocument,
  selectedPartId: string,
  activeTool: ModelingTool
) {
  const params = document.parameters;
  const chamberRadius = params.cavityDiameter / 42;
  const rotorRadius = params.rotorDiameter / 42;
  const eccentricity = params.eccentricity / 20;
  const depth = params.axialWidth / 28;
  const partMap = new Map(document.parts.map((part) => [part.id, part]));
  const section = document.sectionEnabled || activeTool === "section";
  const interference = activeTool === "interference";

  const body = createPartGroup(root, "pump-body", partMap);
  if (body) {
    const bodyMaterial = metalMaterial("pump-body", selectedPartId, BODY_COLOR);
    const arcStart = section ? Math.PI * 0.28 : 0;
    const arcLength = section ? Math.PI * 1.62 : Math.PI * 2;
    const backRing = new THREE.Mesh(
      new THREE.RingGeometry(
        chamberRadius,
        chamberRadius + 0.58,
        72,
        3,
        arcStart,
        arcLength
      ),
      bodyMaterial
    );
    backRing.position.z = -depth * 0.54;
    backRing.castShadow = true;
    backRing.receiveShadow = true;
    tagMesh(backRing, "pump-body");
    body.add(backRing);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(chamberRadius + 0.28, 0.2, 12, 72, arcLength),
      bodyMaterial.clone()
    );
    rim.rotation.z = arcStart;
    rim.position.z = depth * 0.38;
    rim.castShadow = true;
    tagMesh(rim, "pump-body");
    body.add(rim);

    const outerBack = new THREE.Mesh(
      new THREE.CylinderGeometry(
        chamberRadius + 0.52,
        chamberRadius + 0.52,
        Math.max(0.28, depth * 0.23),
        64,
        1,
        false,
        arcStart,
        arcLength
      ),
      bodyMaterial.clone()
    );
    outerBack.rotation.x = Math.PI / 2;
    outerBack.position.z = -depth * 0.46;
    outerBack.castShadow = true;
    tagMesh(outerBack, "pump-body");
    body.add(outerBack);

    for (let index = 0; index < 6; index += 1) {
      const angle = (index / 6) * Math.PI * 2 + 0.18;
      if (section && angle > 0 && angle < Math.PI * 0.46) continue;
      const bolt = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 0.14, 18),
        metalMaterial("pump-body", selectedPartId, DARK_METAL, 0.38)
      );
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(
        Math.cos(angle) * (chamberRadius + 0.31),
        Math.sin(angle) * (chamberRadius + 0.31),
        depth * 0.6
      );
      bolt.castShadow = true;
      tagMesh(bolt, "pump-body");
      body.add(bolt);
    }
  }

  const backCover = createPartGroup(root, "back-cover", partMap);
  if (backCover) {
    const cover = new THREE.Mesh(
      new THREE.CylinderGeometry(
        chamberRadius * 0.98,
        chamberRadius * 0.98,
        0.16,
        64
      ),
      metalMaterial("back-cover", selectedPartId, 0x707879, 0.55)
    );
    cover.rotation.x = Math.PI / 2;
    cover.position.z = -depth * 0.64;
    cover.castShadow = true;
    tagMesh(cover, "back-cover");
    backCover.add(cover);
  }

  const frontCover = createPartGroup(root, "front-cover", partMap);
  if (frontCover) {
    const cover = new THREE.Mesh(
      new THREE.CylinderGeometry(
        chamberRadius * 1.02,
        chamberRadius * 1.02,
        0.12,
        64
      ),
      new THREE.MeshPhysicalMaterial({
        color: selectedPartId === "front-cover" ? SELECTION : 0xb3b9b9,
        transparent: true,
        opacity: 0.3,
        roughness: 0.3,
        metalness: 0.45
      })
    );
    cover.rotation.x = Math.PI / 2;
    cover.position.z = depth * 0.58;
    tagMesh(cover, "front-cover");
    frontCover.add(cover);
  }

  const rotor = createPartGroup(root, "eccentric-rotor", partMap);
  if (rotor) {
    const rotorMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(rotorRadius, rotorRadius, depth * 0.78, 64),
      metalMaterial("eccentric-rotor", selectedPartId, 0x616869, 0.38)
    );
    rotorMesh.rotation.x = Math.PI / 2;
    rotorMesh.position.set(-eccentricity, 0, 0);
    rotorMesh.castShadow = true;
    rotorMesh.receiveShadow = true;
    tagMesh(rotorMesh, "eccentric-rotor");
    rotor.add(rotorMesh);

    const face = new THREE.Mesh(
      new THREE.CylinderGeometry(
        rotorRadius * 0.93,
        rotorRadius * 0.93,
        0.04,
        64
      ),
      metalMaterial("eccentric-rotor", selectedPartId, 0x7f8687, 0.28)
    );
    face.rotation.x = Math.PI / 2;
    face.position.set(-eccentricity, 0, depth * 0.41);
    tagMesh(face, "eccentric-rotor");
    rotor.add(face);
  }

  const vaneCount = V1_VANE_COUNT;
  for (let index = 0; index < vaneCount; index += 1) {
    const partId = index % 2 === 0 ? "vane-1" : "vane-2";
    const vane = createPartGroup(root, partId, partMap);
    if (!vane) continue;
    const angle = index * ((Math.PI * 2) / vaneCount) + Math.PI * 0.19;
    const length = Math.max(
      0.72,
      chamberRadius - rotorRadius + rotorRadius * 0.86
    );
    const materialColor = index === 0 ? TEAL : 0x4d5354;
    const vaneMesh = new THREE.Mesh(
      new THREE.BoxGeometry(
        length,
        Math.max(0.09, params.vaneThickness / 34),
        depth * 0.68
      ),
      metalMaterial(
        partId,
        selectedPartId,
        materialColor,
        index === 0 ? 0.26 : 0.42
      )
    );
    vaneMesh.position.set(
      -eccentricity + Math.cos(angle) * length * 0.46,
      Math.sin(angle) * length * 0.46,
      depth * 0.16
    );
    vaneMesh.rotation.z = angle;
    vaneMesh.castShadow = true;
    tagMesh(vaneMesh, partId);
    vane.add(vaneMesh);
  }

  const shaft = createPartGroup(root, "main-shaft", partMap);
  if (shaft) {
    const shaftRadius = Math.max(0.2, params.shaftDiameter / 44);
    const shaftMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, depth + 2.4, 40),
      metalMaterial("main-shaft", selectedPartId, 0x858c8d, 0.22)
    );
    shaftMesh.rotation.x = Math.PI / 2;
    shaftMesh.position.set(-eccentricity, 0, 0.72);
    shaftMesh.castShadow = true;
    tagMesh(shaftMesh, "main-shaft");
    shaft.add(shaftMesh);
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(
        shaftRadius * 1.65,
        shaftRadius * 1.65,
        0.28,
        40
      ),
      metalMaterial("main-shaft", selectedPartId, 0x5e6566, 0.28)
    );
    collar.rotation.x = Math.PI / 2;
    collar.position.set(-eccentricity, 0, depth * 0.62);
    tagMesh(collar, "main-shaft");
    shaft.add(collar);
  }

  addPort(root, partMap, "inlet", selectedPartId, {
    radius: Math.max(0.28, params.inletWidth / 54),
    position: [-chamberRadius * 0.48, chamberRadius + 0.65, -0.1],
    rotation: [0, 0, 0],
    length: 1.35
  });
  addPort(root, partMap, "outlet", selectedPartId, {
    radius: Math.max(0.25, params.outletWidth / 54),
    position: [chamberRadius + 0.7, 0.18, 0.05],
    rotation: [0, 0, -Math.PI / 2],
    length: 1.55
  });

  const base = createPartGroup(root, "mounting-base", partMap);
  if (base) {
    const material = metalMaterial(
      "mounting-base",
      selectedPartId,
      0x777f80,
      0.58
    );
    const pedestal = new THREE.Mesh(
      new THREE.BoxGeometry(chamberRadius * 1.45, 0.58, depth * 0.9),
      material
    );
    pedestal.position.set(0, -chamberRadius - 0.32, -0.18);
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    tagMesh(pedestal, "mounting-base");
    base.add(pedestal);
    [-1, 1].forEach((side) => {
      const foot = new THREE.Mesh(
        new THREE.BoxGeometry(chamberRadius * 0.72, 0.32, depth * 1.22),
        material.clone()
      );
      foot.position.set(
        side * chamberRadius * 0.82,
        -chamberRadius - 0.72,
        -0.12
      );
      foot.castShadow = true;
      foot.receiveShadow = true;
      tagMesh(foot, "mounting-base");
      base.add(foot);
    });
  }

  if (interference) {
    const clearanceRadius = Math.max(rotorRadius + 0.07, chamberRadius - 0.08);
    const clearance = new THREE.Mesh(
      new THREE.TorusGeometry(clearanceRadius, 0.035, 8, 80),
      new THREE.MeshBasicMaterial({
        color: 0x00b8aa,
        transparent: true,
        opacity: 0.9
      })
    );
    clearance.position.z = depth * 0.48;
    clearance.userData.decorative = true;
    root.add(clearance);
  }

  root.scale.setScalar(0.82);
  root.position.y = -0.12;
}

function addPort(
  root: THREE.Group,
  partMap: Map<string, PumpPart>,
  partId: string,
  selectedPartId: string,
  options: {
    radius: number;
    position: [number, number, number];
    rotation: [number, number, number];
    length: number;
  }
) {
  const group = createPartGroup(root, partId, partMap);
  if (!group) return;
  const pipe = new THREE.Mesh(
    new THREE.CylinderGeometry(
      options.radius,
      options.radius,
      options.length,
      36,
      1,
      true
    ),
    metalMaterial(partId, selectedPartId, 0x7e8687, 0.32)
  );
  pipe.position.set(...options.position);
  pipe.rotation.set(...options.rotation);
  pipe.castShadow = true;
  tagMesh(pipe, partId);
  group.add(pipe);
  const flange = new THREE.Mesh(
    new THREE.CylinderGeometry(
      options.radius * 1.42,
      options.radius * 1.42,
      0.2,
      36
    ),
    metalMaterial(partId, selectedPartId, 0x858c8d, 0.42)
  );
  flange.position.set(
    options.position[0],
    options.position[1] +
      (options.rotation[2] === 0 ? options.length * 0.48 : 0),
    options.position[2]
  );
  flange.rotation.set(...options.rotation);
  tagMesh(flange, partId);
  group.add(flange);
}

function createPartGroup(
  root: THREE.Group,
  partId: string,
  partMap: Map<string, PumpPart>
) {
  const part = partMap.get(partId);
  if (!part || !part.visible) return undefined;
  const group = new THREE.Group();
  group.userData.partId = partId;
  root.add(group);
  return group;
}

function metalMaterial(
  partId: string,
  selectedPartId: string,
  color: number,
  roughness = 0.48
) {
  return new THREE.MeshPhysicalMaterial({
    color: selectedPartId === partId ? SELECTION : color,
    metalness: 0.58,
    roughness,
    clearcoat: 0.12,
    clearcoatRoughness: 0.62,
    emissive: selectedPartId === partId ? 0x063f3b : 0x000000,
    emissiveIntensity: selectedPartId === partId ? 0.22 : 0
  });
}

function tagMesh(mesh: THREE.Object3D, partId: string) {
  mesh.userData.partId = partId;
}

function findPartId(object: THREE.Object3D): string | undefined {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (typeof current.userData.partId === "string")
      return current.userData.partId;
    current = current.parent;
  }
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (
      !(child instanceof THREE.Mesh) &&
      !(child instanceof THREE.LineSegments)
    )
      return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    materials.forEach((material) => material?.dispose());
  });
}
