"""Generates python/src/orchvia/views.py from schemas/protocol.schema.json (SPEC-0033 Y01).

A view names a result's fields as the Python SDK's Snapshot does: known envelope fields in snake
case, others as the wire names them, and nested objects converted only where the SDK converts them.
The names and the conversion come from orchvia.types, so a view cannot drift from the runtime.

Usage: python3 scripts/generate-python-views.py [--check]
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import keyword
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
# types.py alone, without the package, whose client imports the views this script writes.
_spec = importlib.util.spec_from_file_location("_orchvia_types", ROOT / "python" / "src" / "orchvia" / "types.py")
_types = importlib.util.module_from_spec(_spec)
sys.modules["_orchvia_types"] = _types
_spec.loader.exec_module(_types)
_OBJECT_FIELDS, _OBJECT_LIST_FIELDS, _WIRE_TO_PYTHON = _types._OBJECT_FIELDS, _types._OBJECT_LIST_FIELDS, _types._WIRE_TO_PYTHON

SCHEMA = ROOT / "schemas" / "protocol.schema.json"
OUTPUT = ROOT / "python" / "src" / "orchvia" / "views.py"
# The definitions that SDK methods return, and orch.info; their nested views follow.
# Fields that the client converts itself, beyond orchvia.types (usage.summary and usage.by_task).
CONVERTED_BY_CLIENT = {("UsageSummaryView", "totals"), ("UsageTaskTotalsView", "totals")}
# The results of mutations, which the SDK returns with the receipt it keeps for a retry:
# method, scope, idempotency_key and retry_identity (client.Orchestrator._mutate).
RECEIPTS = ["TaskSnapshot", "SessionSnapshot", "MessageSnapshot", "OperationSnapshot"]
RECEIPT_FIELDS = {"method": "str", "scope": "str | None", "idempotency_key": "str",
                  "retry_identity": "RetryIdentityView"}
RESULTS = [
    "InitializeResult", "TaskSnapshot", "TaskListResult", "TaskGetManyResult", "SessionSnapshot",
    "RuntimeInspection", "SchedulerSnapshot", "ExecutionConflict", "MessageSnapshot", "OperationSnapshot",
    "ApprovalRequest", "HandoffRequest", "HandoffListResult", "RuleListResult", "UsageRecord",
    "UsageSummary", "UsageByTaskResult", "SnapshotPage",
]


class Generator:
    def __init__(self, schema: dict):
        self.defs: dict = schema["$defs"]
        self.views: dict[str, list[str]] = {}
        self.fields: dict[str, dict[str, bool]] = {}
        self.nested: dict[str, dict[str, str]] = {}
        # Views whose schema allows fields it does not name; those are read with view["name"].
        self.open: set[str] = set()

    def is_object(self, node: dict) -> bool:
        node = self.resolve(node)
        return node.get("type") == "object" and "properties" in node

    def resolve(self, node: dict) -> dict:
        while "$ref" in node:
            node = self.defs[node["$ref"].split("/")[-1]]
        return node

    def type_of(self, node: dict, converted: bool, owner: str, name: str) -> str:
        if "$ref" in node:
            target = node["$ref"].split("/")[-1]
            if self.is_object(node):
                if converted:
                    self.view(target)
                    self.nested.setdefault(owner, {})[name] = f"{target}View"
                    return f"{target}View"
                return "Mapping[str, Any]"
            return self.type_of(self.defs[target], converted, owner, name)
        if "const" in node:
            return f"Literal[{json.dumps(node['const'])}]"
        if "enum" in node:
            values = [value for value in node["enum"] if value is not None]
            literal = f"Literal[{', '.join(json.dumps(value) for value in values)}]" if values else "None"
            return f"{literal} | None" if None in node["enum"] and values else literal
        for combinator in ("oneOf", "anyOf"):
            if combinator in node:
                parts = []
                for choice in node[combinator]:
                    part = self.type_of(choice, converted, owner, name)
                    if part not in parts:
                        parts.append(part)
                return "Any" if len(parts) > 4 else " | ".join(parts)
        kind = node.get("type")
        if isinstance(kind, list):
            parts = [self.type_of({**node, "type": item}, converted, owner, name) for item in kind]
            return " | ".join(dict.fromkeys(parts))
        if kind == "string":
            return "str"
        if kind == "integer":
            return "int"
        if kind == "number":
            return "float"
        if kind == "boolean":
            return "bool"
        if kind == "null":
            return "None"
        if kind == "array":
            item = node.get("items", {})
            if converted and self.is_object(item):
                return f"Sequence[{self.type_of(item, True, owner, name)}]"
            return f"Sequence[{self.type_of(item, False, owner, name) if not self.is_object(item) else 'Mapping[str, Any]'}]"
        if kind == "object":
            if converted and "properties" in node:
                inline = f"{owner.removesuffix('View')}{''.join(part.capitalize() for part in name.split('_'))}"
                self.view(inline, node)
                self.nested.setdefault(owner, {})[name] = f"{inline}View"
                return f"{inline}View"
            return "Mapping[str, Any]"
        return "Any"

    def view(self, name: str, node: dict | None = None) -> None:
        if f"{name}View" in self.views:
            return
        view = f"{name}View"
        self.views[view] = []  # Claims the name before recursing.
        node = node if node is not None else self.defs[name]
        required = set(node.get("required", []))
        if node.get("additionalProperties", True) is not False:
            self.open.add(view)
        lines: list[str] = []
        fields: dict[str, bool] = {}
        for key, child in node.get("properties", {}).items():
            python = _WIRE_TO_PYTHON.get(key, key)
            fields[python] = key in required
            converted = (key in _OBJECT_FIELDS or key in _OBJECT_LIST_FIELDS
                         or (view, python) in CONVERTED_BY_CLIENT)
            annotation = self.type_of(child, converted, view, python)
            if not python.isidentifier() or keyword.iskeyword(python):
                lines.append(f"    # {python!r}: {annotation}; read it with view[{python!r}].")
                continue
            description = " ".join(str(child.get("description", "")).split())
            if not required.__contains__(key):
                description = (description + " " if description else "") + "Absent when not set; use get()."
            lines.append("    @property")
            lines.append(f"    def {python}(self) -> {annotation}:")
            if description:
                lines.append(f"        {json.dumps(description, ensure_ascii=False)}")
            lines.append("        ...")
        self.views[view] = lines
        self.fields[view] = fields

    def render(self) -> str:
        for name in RESULTS:
            self.view(name)
        self.view("RetryIdentity")
        receipt = ["class ReceiptView(View, Protocol):",
                   '    """What the SDK adds to the result of a mutation, for a retry or a lookup."""']
        for field, annotation in RECEIPT_FIELDS.items():
            receipt += ["    @property", f"    def {field}(self) -> {annotation}:", "        ..."]
        for name in RECEIPTS:
            short = name.removesuffix("Snapshot")
            self.views[f"{short}ReceiptView"] = [f'    """{name}View as a mutation returns it, with its receipt."""']
            self.fields[f"{short}ReceiptView"] = {**self.fields[f"{name}View"],
                                                  **{field: True for field in RECEIPT_FIELDS}}
            self.nested[f"{short}ReceiptView"] = {**self.nested.get(f"{name}View", {}),
                                                  "retry_identity": "RetryIdentityView"}
        digest = hashlib.sha256(SCHEMA.read_bytes()).hexdigest()
        out = [
            f'"""Generated by scripts/generate-python-views.py from schemas/protocol.schema.json; SHA-256 {digest}. Do not edit.',
            "",
            "Read-only views of the SDK's results, for editors and type checkers (SPEC-0033 Y01). At run time",
            "every result is a Snapshot; a view only describes it. Raw JSON keeps the wire's names.",
            '"""',
            "from __future__ import annotations",
            "",
            "from collections.abc import Iterator, Mapping, Sequence",
            "from typing import Any, Literal, Protocol",
            "",
            "",
            "class View(Protocol):",
            '    """What every view offers: read-only mapping access, as a Snapshot."""',
            "    def __getitem__(self, key: str) -> Any: ...",
            "    def __iter__(self) -> Iterator[str]: ...",
            "    def __len__(self) -> int: ...",
            "    def __contains__(self, key: object) -> bool: ...",
            "    def get(self, key: str, default: Any = None) -> Any: ...",
            "    def keys(self) -> Any: ...",
            "    def as_dict(self) -> dict[str, Any]: ...",
        ]
        out += ["", ""] + receipt
        # Receipt views last: a class's bases must exist before it.
        for view in sorted(self.views, key=lambda name: (name.endswith("ReceiptView"), name)):
            bases = (f"{view.removesuffix('ReceiptView')}SnapshotView, ReceiptView"
                     if view.endswith("ReceiptView") else "View")
            out += ["", "", f"class {view}({bases}, Protocol):"]
            out += self.views[view] or ["    pass"]
        out += ["", "", "# Each view's fields as Python names them, and whether the schema requires them.",
                "FIELDS: dict[str, dict[str, bool]] = {"]
        for view in sorted(self.fields):
            out.append(f"    {json.dumps(view)}: {json.dumps(self.fields[view], sort_keys=True)},".replace("true", "True").replace("false", "False"))
        out += ["}", "# The fields that hold nested views.", "NESTED: dict[str, dict[str, str]] = {"]
        for view in sorted(self.nested):
            out.append(f"    {json.dumps(view)}: {json.dumps(self.nested[view], sort_keys=True)},")
        out += ["}", "# Views whose results may hold further fields, read with view[\"name\"].",
                f"OPEN: frozenset[str] = frozenset({json.dumps(sorted(self.open))})", ""]
        return "\n".join(out)


def render() -> str:
    return Generator(json.loads(SCHEMA.read_text())).render()


if __name__ == "__main__":
    text = render()
    if "--check" in sys.argv[1:]:
        if OUTPUT.read_text() != text:
            sys.exit(f"{OUTPUT.relative_to(ROOT)} is out of date; run python3 scripts/generate-python-views.py")
        print(json.dumps({"views": text.count(", Protocol):"), "mode": "check"}))
    else:
        OUTPUT.write_text(text)
        print(json.dumps({"views": text.count(", Protocol):"), "mode": "write"}))
