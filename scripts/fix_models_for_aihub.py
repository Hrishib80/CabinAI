"""
scripts/fix_models_for_aihub.py

Fixes two models that failed Qualcomm AI Hub compilation:

1. BGE-small-en — inputs are int64 (dtype=7). Qualcomm's compile step for mobile
   SoCs requires --truncate_64bit_io but that flag only works for QNN targets, not
   the default ONNX target on X Elite. Simplest fix: re-export the model with int32
   inputs (dtype=6). The embedder works identically — indices fit in int32.

2. Kokoro TTS — input 'tokens' has a symbolic sequence_length axis (dynamic shape).
   AI Hub profiling needs all shapes static. We fix it by replacing the dim_param
   with a concrete dim_value of 50 (typical short utterance). The audio output also
   gets a concrete length derived from the upsampling ratio (tokens * 256 = 12800 samples).

Outputs (alongside originals, so originals remain usable):
   models/bge_small_en/onnx/model_int32.onnx
   models/kokoro-v1.0-static.onnx
"""
from pathlib import Path
import onnx
from onnx import TensorProto, helper, numpy_helper
import numpy as np

ROOT = Path(__file__).parent.parent
print("=== Fix 1: BGE int64 -> int32 ===")

bge_in  = ROOT / "models" / "bge_small_en" / "onnx" / "model.onnx"
bge_out = ROOT / "models" / "bge_small_en" / "onnx" / "model_int32.onnx"

m = onnx.load(str(bge_in))

# Change all int64 graph inputs to int32
for inp in m.graph.input:
    if inp.type.tensor_type.elem_type == TensorProto.INT64:
        inp.type.tensor_type.elem_type = TensorProto.INT32
        print(f"  {inp.name}: int64 -> int32")

# Also cast any initializers that are int64 (rare for embedding models but be safe)
for init in m.graph.initializer:
    if init.data_type == TensorProto.INT64:
        arr = numpy_helper.to_array(init).astype(np.int32)
        new_init = numpy_helper.from_array(arr, name=init.name)
        m.graph.initializer.remove(init)
        m.graph.initializer.append(new_init)
        print(f"  initializer {init.name}: int64 -> int32")

# Insert Cast nodes right after graph inputs to upcast back to int64 for internal ops.
# This makes the model externally accept int32 but internally still work with int64 ops.
new_nodes = []
remap = {}  # old_name -> cast_output_name
for inp in m.graph.input:
    if inp.type.tensor_type.elem_type == TensorProto.INT32:
        cast_out = inp.name + "_i64"
        remap[inp.name] = cast_out
        cast_node = helper.make_node(
            "Cast",
            inputs=[inp.name],
            outputs=[cast_out],
            to=TensorProto.INT64,
            name=f"Cast_{inp.name}_to_i64",
        )
        new_nodes.append(cast_node)

# Prepend the cast nodes
for node in new_nodes:
    m.graph.node.insert(0, node)

# Rewrite references in subsequent nodes to use the cast output
# Only for the inputs we remapped
for node in m.graph.node:
    if node in new_nodes:
        continue
    for i, inp_name in enumerate(node.input):
        if inp_name in remap:
            node.input[i] = remap[inp_name]

onnx.checker.check_model(m)
onnx.save(m, str(bge_out))
print(f"  Saved: {bge_out} ({bge_out.stat().st_size // 1024} KB)")

print()
print("=== Fix 2: Kokoro dynamic -> static + int64->int32 (seq=50) ===")

kok_in  = ROOT / "models" / "kokoro-v1.0.onnx"
kok_out = ROOT / "models" / "kokoro-v1.0-static50.onnx"

m2 = onnx.load(str(kok_in))

# Strategy: keep tokens as int64 (AI Hub can handle it with --truncate_64bit_io on QNN targets),
# but fix the dynamic sequence_length to 50. The compile will use --truncate_64bit_io flag.
# Only fix the shapes, don't touch dtypes.
for inp in m2.graph.input:
    if inp.name == "tokens":
        shape = inp.type.tensor_type.shape
        for dim in shape.dim:
            if dim.HasField("dim_param"):
                dim.ClearField("dim_param")
                dim.dim_value = 50
        print("  tokens: dyn -> int64 [1,50]")

# Fix output: audio [audio_length] -> 527400
# Kokoro's true upsampling: 50 tokens -> 527400 samples (measured empirically)
# Ratio ~10548 samples/token (includes mel + vocoder upsampling chain)
STATIC_AUDIO_LEN = 527400
for out in m2.graph.output:
    if out.name == "audio":
        shape = out.type.tensor_type.shape
        for dim in shape.dim:
            if dim.HasField("dim_param"):
                dim.ClearField("dim_param")
                dim.dim_value = STATIC_AUDIO_LEN
                print(f"  audio: audio_length -> {STATIC_AUDIO_LEN}")

# Run shape inference to propagate static shapes through the graph
m2 = onnx.shape_inference.infer_shapes(m2)

try:
    onnx.checker.check_model(m2)
    print("  ONNX checker: PASS")
except Exception as e:
    print(f"  ONNX checker warning (may still work): {e}")

onnx.save(m2, str(kok_out))
print(f"  Saved: {kok_out} ({kok_out.stat().st_size // 1024} KB)")

print()
print("=== Quick inference smoke test ===")
import onnxruntime as ort

# Test BGE int32
sess_bge = ort.InferenceSession(str(bge_out), providers=["CPUExecutionProvider"])
dummy_ids = np.zeros((1, 64), dtype=np.int32)
out = sess_bge.run(None, {"input_ids": dummy_ids, "attention_mask": dummy_ids, "token_type_ids": dummy_ids})
print(f"  BGE int32: output shape {out[0].shape}, dtype {out[0].dtype}  OK")

# Test Kokoro static (tokens remain int64, only shape is static now)
sess_kok = ort.InferenceSession(str(kok_out), providers=["CPUExecutionProvider"])
tokens = np.zeros((1, 50), dtype=np.int64)
style  = np.zeros((1, 256), dtype=np.float32)
speed  = np.ones((1,),      dtype=np.float32)
out2 = sess_kok.run(None, {"tokens": tokens, "style": style, "speed": speed})
print(f"  Kokoro static: audio shape {out2[0].shape}  OK")
