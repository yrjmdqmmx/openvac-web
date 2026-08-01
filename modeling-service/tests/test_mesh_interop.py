from pathlib import Path

import pytest

from app.engine import build_to_artifacts


def test_stl_and_glb_preserve_millimetre_scale_and_load(tmp_path: Path) -> None:
    vtk = pytest.importorskip("vtk")
    pytest.importorskip("cadquery")
    response = build_to_artifacts(
        "mesh-interop",
        {
            "name": "30 x 20 x 10 mm scale block",
            "features": [
                {
                    "id": "block",
                    "kind": "box",
                    "parameters": {"width": 30, "depth": 20, "height": 10},
                }
            ],
        },
        ["stl", "glb"],
        tmp_path.resolve(),
        False,
    )
    assert response.valid is True

    stl_reader = vtk.vtkSTLReader()
    stl_reader.SetFileName(str(tmp_path / "mesh-interop" / "model.stl"))
    stl_reader.Update()
    stl_bounds = stl_reader.GetOutput().GetBounds()
    stl_extents = sorted(stl_bounds[index + 1] - stl_bounds[index] for index in (0, 2, 4))
    assert stl_reader.GetOutput().GetNumberOfPoints() > 0
    assert stl_extents == pytest.approx([10, 20, 30], abs=0.001)

    glb_reader = vtk.vtkGLTFReader()
    glb_reader.SetFileName(str(tmp_path / "mesh-interop" / "model.glb"))
    glb_reader.Update()
    geometry = vtk.vtkCompositeDataGeometryFilter()
    geometry.SetInputDataObject(glb_reader.GetOutput())
    geometry.Update()
    glb_mesh = geometry.GetOutput()
    glb_bounds = glb_mesh.GetBounds()
    glb_extents = sorted(glb_bounds[index + 1] - glb_bounds[index] for index in (0, 2, 4))
    assert glb_mesh.GetNumberOfPoints() > 0
    # glTF is Y-up, so axes can be permuted; physical millimetre scale remains.
    assert glb_extents == pytest.approx([10, 20, 30], abs=0.001)
