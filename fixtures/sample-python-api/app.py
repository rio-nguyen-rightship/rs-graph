from flask import Flask

from api.controller import GreetingController
from domain.greeter import Greeter

app = Flask(__name__)
controller = GreetingController(Greeter())


@app.get("/api/greeting/<name>")
def get_greeting(name):
    return controller.get(name)


if __name__ == "__main__":
    app.run()
