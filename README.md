# Tinfoil Containers Template

A GitHub template repository for deploying a pre-built Docker image as a [Tinfoil Container](https://docs.tinfoil.sh/containers/overview) (in a secure enclave)

Out of the box, this template deploys [`tinfoil-containers-hello-world`](https://github.com/tinfoilsh/tinfoil-containers-hello-world): a tiny HTTP server that reads a `MESSAGE` env var and a `GREETING_TOKEN` secret, and responds with both.

## Deploy It

1. Click **[Use this template](https://github.com/tinfoilsh/tinfoil-containers-template/generate)** → **Create a new repository**
2. In the [Tinfoil Dashboard](https://dash.tinfoil.sh), open the **Secrets** tab and add `GREETING_TOKEN` with any value
3. Release a version by running the **Tinfoil Release** workflow:
   - **CLI:** `gh workflow run tinfoil-release.yml -f version=v0.0.1`
   - **UI:** **Actions** tab → **Tinfoil Release** → **Run workflow**, then enter the version
4. **Containers** → **Deploy**, select your repo and tag, and click **Deploy**

Once running, `curl https://<container-name>.<org>.containers.tinfoil.dev` returns:

```
MESSAGE: <value from tinfoil-config.yml>
GREETING_TOKEN: <present if secret exists>
```

## Use your own image

1. If you have a prebuilt image, edit `tinfoil-config.yml` to point at the image you want to deploy: change `image:` to your `<repo>@sha256:<digest>`, adjust `env`/`secrets`/`shim` for your container, then release a new version.
2. If you have your own code in a private repo, [`tinfoil-containers-hello-world`](https://github.com/tinfoilsh/tinfoil-containers-hello-world) shows the build-and-publish side and can be added to an existing repository.
3. If you have your own code in a public repo, use the simple [`tinfoil-public-containers-template`](https://github.com/tinfoilsh/tinfoil-public-containers-template) for an all-in-one-repo example. Since the `tinfoil-config.yml` has to be public, public app code can live in the same repo as the config.

## Updating

Edit `tinfoil-config.yml`, commit, then release a new version (`gh workflow run tinfoil-release.yml -f version=v0.0.2`, or via the **Actions** tab). Then click **Update** in the dashboard. Each release creates an auditable record in the Sigstore transparency log.

## Documentation

For the full configuration reference, secrets management, debug mode, and more:

**[docs.tinfoil.sh/containers](https://docs.tinfoil.sh/containers/overview)**

## Support

- [Documentation](https://docs.tinfoil.sh)
- [Email Support](mailto:contact@tinfoil.sh)
