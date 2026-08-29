import os

from flask import Flask, send_from_directory

from logviewer.routes import api

app = Flask(__name__, static_folder="static", static_url_path="")
app.register_blueprint(api)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5057))
    app.run(host="127.0.0.1", port=port, debug=True)
