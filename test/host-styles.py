"""Run host functions read-only with only the HTTP response boundary mocked."""
import ast
import json
import logging
import mimetypes
from pathlib import Path
import sys
import threading

host, root = map(Path, sys.argv[1:])
manifest = json.loads((root / 'plugin.json').read_text())


def load_function(source, name, namespace):
    tree = ast.parse(source)
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(host), 'exec'), namespace)
    return namespace[name]


class Response:
    def __init__(self, body='', status_code=200, media_type=None):
        self.body, self.status_code, self.media_type = body, status_code, media_type


ns = {
    'Path': Path, 'Request': object, 'Response': Response,
    'mimetypes': mimetypes, 'log': logging.getLogger('host-styles-test'),
    'PLUGINS_LOCK': threading.Lock(),
    'LOADED_PLUGINS': [{'id': manifest['id'], '_dir': root}],
    '_plugin_file_response': lambda request, target, media_type: Response(target.read_text(), media_type=media_type),
    '_capability_warnings': lambda *args: ({}, [], []),
    '_is_bundled': lambda *args: False,
    '_is_valid_tour_manifest': lambda *args: False,
    '_normalize_string_list': lambda value: value or [],
    '_normalize_manifest_mapping': lambda value: value or {},
    '_compatibility_shims_from_manifest': lambda *args: [],
    '_normalize_ui_contributions': lambda *args: [],
    '_normalize_runtime_domains': lambda *args: [],
}
# Execute the real containment helper without importing the host application.
safe_source = (host / 'lib/safepath.py').read_text()
exec(compile(safe_source, str(host / 'lib/safepath.py'), 'exec'), ns)
source = (host / 'plugins/__init__.py').read_text()
nav = load_function(source, '_nav_entry', ns)(manifest['id'], root, manifest, 0)
load_function(source, '_plugin_media_type', ns)
route = load_function(source, 'plugin_asset', ns)
response = route(object(), manifest['id'], nav['styles'].removeprefix('assets/'))
result = {
    'has_styles': nav['has_styles'], 'styles': nav['styles'],
    'status': response.status_code, 'media_type': response.media_type, 'body': response.body,
    'traversal_status': route(object(), manifest['id'], '../game.js').status_code,
    'missing_status': route(object(), manifest['id'], 'missing.css').status_code,
}
ns['LOADED_PLUGINS'][0]['status'] = 'installing'
result['pending_status'] = route(object(), manifest['id'], 'game.css').status_code
print(json.dumps(result))
