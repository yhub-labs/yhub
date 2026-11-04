"""Declarative parameter schema: the ``params`` format shared by the three faces (HTTP
routes / MCP / CLI) plus its assemblers.

A ``params`` is a ``list[dict]``; each item's core keys (the rest are per-face hints):

    {"name": "q", "type": "str", "required": True, "help": "word to look up"}
    {"name": "traditional", "type": "bool", "default": False, "help": "use the traditional path"}

    name       identifier, required
    type       str | int | float | bool | list[str] (set "nullable": True for Optional)
    default    present means optional; absent and not explicitly required=False means required
               (same meaning as the old mcp string format)
    required   True/False, explicitly overrides the rule above
    help       plain description (OpenAPI for HTTP, --help for CLI)
    ge / le    numeric bounds (Query/Field validation on HTTP; ignored by MCP/CLI)

    Face keys: HTTP -- "in": "query" (default) | "body" (body items carry "fields": [items
                     above]; "name" is the argument name the endpoint glue receives)
               CLI  -- "positional": True, "nargs": "*|+|?", "choices": [...], "short": "t"

A wrong declaration is an authoring bug: everything here raises ValueError (with `where` for
localization), red at startup, so a bad declaration never degrades quietly into "the
parameter behaves differently from its declaration".
"""

from __future__ import annotations

import inspect
import re
from typing import Any, Optional

from yhub.i18n import tr

TYPES: dict[str, type] = {
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "list[str]": list,
}
# Full set of allowed keys (face-specific keys are registered here too, so a typo raises
# instead of being ignored)
_KEYS = {
    "name", "type", "required", "default", "help", "ge", "le", "nullable",
    # HTTP face
    "in", "fields",
    # CLI face
    "positional", "nargs", "choices", "short",
}


def _bad(where: str, msg: str) -> ValueError:
    return ValueError(f"[{where}] {msg}")


def python_type(param: dict, *, where: str) -> Any:
    """Turn a declared type string into a runtime annotation (wrapping Optional when nullable)."""
    raw = param.get("type")
    if raw not in TYPES:
        raise _bad(where, tr("params.err.type_unknown", param=repr(param.get('name')),
                             type=repr(raw), allowed=sorted(TYPES)))
    ann: Any = TYPES[raw]
    if param.get("nullable"):
        ann = Optional[ann]
    return ann


def normalize_params(params: Any, *, where: str) -> list[dict]:
    """Validate and return the params list (every item a dict, keys legal, names unique)."""
    if params is None:
        return []
    if not isinstance(params, (list, tuple)):
        raise _bad(where, tr("params.err.not_list", type=type(params).__name__))
    seen: set[str] = set()
    out: list[dict] = []
    for i, item in enumerate(params):
        if not isinstance(item, dict):
            raise _bad(where, tr("params.err.item_not_dict", index=i, type=type(item).__name__))
        unknown = set(item) - _KEYS
        if unknown:
            raise _bad(where, tr("params.err.unknown_keys", index=i, keys=sorted(unknown)))
        name = item.get("name")
        if not isinstance(name, str) or not name.isidentifier():
            raise _bad(where, tr("params.err.name_invalid", index=i, name=repr(name)))
        if name in seen:
            raise _bad(where, tr("params.err.duplicate", name=repr(name)))
        seen.add(name)
        if "in" in item and item["in"] != "body" and item["in"] != "query":
            raise _bad(where, tr("params.err.location_unknown", name=repr(name),
                                 location=repr(item['in'])))
        if item.get("in") == "body":
            # body container item: carries no type of its own, its fields live in fields
            # (validated recursively)
            if "fields" not in item:
                raise _bad(where, tr("params.err.body_fields_missing", name=repr(name)))
            item["fields"] = normalize_params(item["fields"], where=f"{where}.{name}.fields")
            out.append(item)
            continue
        if "type" not in item:
            raise _bad(where, tr("params.err.type_missing", name=repr(name)))
        python_type(item, where=where)  # validate the type along the way
        # Optional params must provide a default (CLI positional args excepted: argparse
        # supplies the nargs default itself)
        required = item.get("required", "default" not in item)
        if not required and "default" not in item and not item.get("positional"):
            raise _bad(where, tr("params.err.optional_needs_default", name=repr(name)))
        if item.get("required") is True and "default" in item:
            raise _bad(where, tr("params.err.required_with_default", name=repr(name)))
        out.append(item)
    return out


def mcp_signature(params: Any, *, where: str) -> inspect.Signature:
    """MCP face: generate the handler signature from params (FastMCP derives the input schema
    from the signature)."""
    sig_params = []
    for p in normalize_params(params, where=where):
        required = p.get("required", "default" not in p)
        default = inspect.Parameter.empty if required else p.get("default", None)
        sig_params.append(
            inspect.Parameter(
                p["name"],
                kind=inspect.Parameter.POSITIONAL_OR_KEYWORD,
                annotation=python_type(p, where=where),
                default=default,
            )
        )
    return inspect.Signature(sig_params)


def _path_params(path: str) -> list[str]:
    """Extract path parameters from a path template (`{cell_id}` and `{relpath:path}` both count)."""
    return re.findall(r"{(\w+)(?::[^}]+)?}", path)


def apply_route_params(endpoint, route: dict, *, where: str) -> None:
    """HTTP face: rewrite the endpoint's ``__signature__`` from the declarations (FastAPI binds
    and validates parameters from it).

    * path params: extracted from the path template (str, required), no declaration needed;
    * query params: ``default = fastapi.Query(...)`` (carrying description and ge/le);
    * body params: a model created dynamically via ``pydantic.create_model``; the endpoint
      glue receives the model instance (attribute access unchanged, zero glue edits).

    Parameters absent from params never enter the signature -- the declaration is the whole
    truth about it.
    """
    from fastapi import Query  # lazy: the CLI face only needs mcp_signature, not fastapi
    from pydantic import Field, create_model

    entries = normalize_params(route.get("params"), where=where)
    sig_params: list[inspect.Parameter] = []

    # Glue compatibility check: the endpoint must accept every declared parameter (guards
    # against a declared-but-unhandled param turning into a 500). Verified against the
    # signature **before** rewriting -- that is the truth while the glue is untouched; on
    # repeated calls the previously written signature still holds the same names.
    original = inspect.signature(endpoint)
    accepts_var_kw = any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in original.parameters.values()
    )
    for p in entries:
        if p["name"] not in original.parameters and not accepts_var_kw:
            raise _bad(where, tr("params.err.endpoint_missing_param", endpoint=endpoint.__name__,
                                 name=repr(p['name'])))

    declared_path = {p["name"] for p in entries if p.get("in") == "path"}
    for name in _path_params(route["path"]):
        if name in declared_path:
            raise _bad(where, tr("params.err.path_param_declared", name=repr(name)))
        if name not in original.parameters and not accepts_var_kw:
            raise _bad(where, tr("params.err.endpoint_missing_path_param",
                                 endpoint=endpoint.__name__, name=repr(name)))
        sig_params.append(
            inspect.Parameter(name, kind=inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=str)
        )

    for p in entries:
        where_p = f"{where}.{p['name']}"
        kind = p.get("in", "query")
        if kind == "path":
            raise _bad(where_p, tr("params.err.in_path_redundant"))
        if kind == "body":
            fields = normalize_params(p.get("fields"), where=where_p)
            if not fields:
                raise _bad(where_p, tr("params.err.body_fields_empty"))
            model_fields = {}
            for f in fields:
                required = f.get("required", "default" not in f)
                field_kwargs: dict[str, Any] = {}
                if f.get("help"):
                    field_kwargs["description"] = f["help"]
                for bound in ("ge", "le"):
                    if bound in f:
                        field_kwargs[bound] = f[bound]
                default = Field(..., **field_kwargs) if required else Field(f.get("default"), **field_kwargs)
                model_fields[f["name"]] = (python_type(f, where=where_p), default)
            # Model name derived from the endpoint function (affects the OpenAPI schema name
            # only; it just has to be stable)
            core = endpoint.__name__.replace("route", "_").replace("__", "_").strip("_")
            model_name = "".join(seg.title() for seg in core.split("_") if seg) + "In" or "BodyIn"
            model = create_model(model_name, **model_fields)
            # The whole body is required; a missing field still yields 422.
            sig_params.append(
                inspect.Parameter(p["name"], kind=inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=model)
            )
            continue
        if kind != "query":
            raise _bad(where_p, tr("params.err.in_unknown", kind=repr(kind)))
        required = p.get("required", "default" not in p)
        query_kwargs: dict[str, Any] = {}
        if p.get("help"):
            query_kwargs["description"] = p["help"]
        for bound in ("ge", "le"):
            if bound in p:
                query_kwargs[bound] = p[bound]
        default = Query(..., **query_kwargs) if required else Query(p.get("default"), **query_kwargs)
        sig_params.append(
            inspect.Parameter(
                p["name"],
                kind=inspect.Parameter.POSITIONAL_OR_KEYWORD,
                annotation=python_type(p, where=where_p),
                default=default,
            )
        )

    endpoint.__signature__ = inspect.Signature(sig_params)


def cli_param_spec(params: Any, *, where: str) -> list[dict]:
    """CLI face: validate and forward only (argparse assembly lives in yhub/cli/generate.py)."""
    return normalize_params(params, where=where)
