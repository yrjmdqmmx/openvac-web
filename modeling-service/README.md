# OpenVac Modeling Service

This service is the deterministic CAD executor behind the OpenVac web application. It accepts only the versioned `openvac.modeling.v1` protocol and never executes model-generated Python or shell code.

## Responsibilities

- Solve bounded 2D sketches with SolveSpace `slvs` in a fresh subprocess.
- Build valid B-Rep solids and assemblies with CadQuery/OCP/OCCT.
- Generate private STEP, STL, and GLB artifacts.
- Build and validate the original `OpenVac-RV1` single-stage rotary-vane reference model.
- Contain native-kernel crashes and timeouts outside the Next.js process.

The pump validator combines deterministic analytic invariants with OCCT B-Rep
evidence. It samples the rotating group at a circular step no larger than one
degree, checks rotor/vane/shaft/chamber interference, and proves that the inlet
and outlet are real housing cuts connected from the exterior to the chamber.
Its swept-volume value remains a deterministic geometry proxy, not pumping
speed, CFD, leakage, thermal, or production-performance evidence.

## V1 semantic boundaries

- The original single-stage rotary-vane pump is a strict, fixed-recipe
  parametric template. V1 accepts edits to its declared parameters, but it is
  not a generic replay of arbitrary pump feature trees. Deleted, suppressed,
  reordered, or structurally rewritten recipe nodes fail closed before B-Rep
  generation.
- The fixed recipe contains explicit front and rear cover sketches, features,
  components, and assembly constraints. Their shaft bores are centered on the
  eccentric shaft axis, while the outer cover circles remain centered on the
  chamber axis. Cover dimensions are non-editable values derived from the
  declared pump dimensions.
- Inlet and outlet `port` features are subtractive radial passages through the
  housing wall. They are not decorative solid cylinders. Registration requires
  positive OCCT cut/chamber/exterior intersection evidence and a zero-volume
  residual blockage probe.
- Assembly solving is limited to deterministic component datums: each
  component's local origin and local Z axis. `fixed`, `coincident`,
  `concentric`, and `distance` constraints use those datums; arbitrary OCCT
  face mates and inferred topology indices are not supported.
- A verified STEP upload becomes one immutable `imported_step` base feature.
  Later native features may reference that base and rebuild in the same OCCT
  history, while the service never fabricates the source model's feature tree.
- Every generated STEP is re-imported and checked for valid solids, bounding
  box, and volume tolerances before registration. STL and GLB are loaded back
  through VTK and checked for non-empty geometry, unit scale, and envelope.
- Volume, surface area, envelope, and center of mass come from the B-Rep. Mass
  is computed only when `metadata.material` contains a positive density with
  `densitySource=user`; otherwise the response reports
  `unavailable_density_required` and a null mass instead of guessing a material.
- Public patents and vendor service material are topology, appearance,
  interface, and acceptance references only. They do not supply manufacturing
  dimensions; unknown dimensions must come from explicit user input and AI
  output is never treated as manufacturing truth.

## Local development

Use Python 3.12 because CadQuery and `slvs` wheels are pinned for that runtime.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e '.[test]'
MODELING_ARTIFACT_ROOT=./storage/artifacts .venv/bin/pytest
MODELING_ARTIFACT_ROOT=./storage/artifacts .venv/bin/uvicorn app.main:app --reload
```

Run the same isolated subprocess path used by production for the three latency
acceptance cases:

```bash
.venv/bin/python -m app.benchmark --case all --iterations 20
```

The JSON report is evidence for the machine on which it ran only. A laptop
result does not satisfy the Debian target-host gate.

Set `MODELING_SERVICE_TOKEN` outside development. The Compose `modeling`
profile also sets `MODELING_REQUIRE_SERVICE_TOKEN=true`, so readiness and every
authenticated endpoint fail closed when the token is absent. All `/v1/*`
endpoints require the `X-OpenVac-Service-Token` header when a token is
configured. `/health` remains unauthenticated for the container health check.
