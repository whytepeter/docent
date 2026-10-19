import os

from app import create_app


def main() -> None:
    create_app().run(port=int(os.getenv("PORT", "5000")))


if __name__ == "__main__":
    main()
