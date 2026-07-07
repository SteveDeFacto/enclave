#!/usr/bin/env python3
"""Generates src/model.onnx: the smallest useful inference graph — Y = X + B,
X input fp32[1,4], B initializer [10,20,30,40], Y output fp32[1,4]. The app
feeds X=[1,2,3,4] and checks Y=[11,22,33,44], so a single request proves the
whole wasi-nn path (guest -> wasmtime -> ONNX Runtime -> CPU or CUDA EP).

Regenerate only if the check values change:  pip install onnx && python3 gen-model.py
"""
import pathlib

import onnx
from onnx import TensorProto, helper

B = helper.make_tensor("B", TensorProto.FLOAT, [1, 4], [10.0, 20.0, 30.0, 40.0])
graph = helper.make_graph(
    nodes=[helper.make_node("Add", inputs=["X", "B"], outputs=["Y"])],
    name="enclave-nn-demo",
    inputs=[helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 4])],
    outputs=[helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 4])],
    initializer=[B],
)
# IR/opset pinned low on purpose: Add-7 is ancient and runs on every ORT build.
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)
onnx.checker.check_model(model)
out = pathlib.Path(__file__).parent / "src" / "model.onnx"
out.write_bytes(model.SerializeToString())
print(f"wrote {out} ({out.stat().st_size} bytes)")
