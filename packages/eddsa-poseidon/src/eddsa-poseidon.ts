import {
    Base8,
    Fr,
    Point,
    addPoint,
    inCurve,
    mulPointEscalar,
    packPoint,
    subOrder,
    unpackPoint
} from "@zk-kit/baby-jubjub"
import {
    BigNumber,
    BigNumberish,
    F1Field,
    isHexadecimal,
    isStringifiedBigint,
    leBigIntToBuffer,
    leBufferToBigInt,
    scalar
} from "@zk-kit/utils"
import { poseidon5 } from "poseidon-lite/poseidon5"
import blake from "./blake"
import { Signature } from "./types"
import * as utils from "./utils"

/**
 * Derives a secret scalar from a given EdDSA private key.
 * This process involves hashing the private key with Blake1, pruning the resulting hash to retain the lower 32 bytes,
 * and converting it into a little-endian integer. The use of the secret scalar streamlines the public key generation
 * process by omitting steps 1, 2, and 3 as outlined in RFC 8032 section 5.1.5, enhancing circuit efficiency and simplicity.
 * This method is crucial for fixed-base scalar multiplication operations within the correspondent cryptographic circuit.
 * For detailed steps, see: {@link https://datatracker.ietf.org/doc/html/rfc8032#section-5.1.5}.
 * For example usage in a circuit, see: {@link https://github.com/semaphore-protocol/semaphore/blob/2c144fc9e55b30ad09474aeafa763c4115338409/packages/circuits/semaphore.circom#L21}
 * @param privateKey The EdDSA private key for generating the associated public key.
 * @returns The derived secret scalar to be used to calculate public key and optimized for circuit calculations.
 */
export function deriveSecretScalar(privateKey: BigNumberish): string {
    // Convert the private key to buffer.
    privateKey = utils.checkPrivateKey(privateKey)

    let hash = blake(privateKey)

    hash = hash.slice(0, 32)
    hash = utils.pruneBuffer(hash)

    return scalar.shiftRight(leBufferToBigInt(hash), BigInt(3)).toString()
}

/**
 * Derives a public key from a given private key using the
 * {@link https://eips.ethereum.org/EIPS/eip-2494|Baby Jubjub} elliptic curve.
 * This function utilizes the Baby Jubjub elliptic curve for cryptographic operations.
 * The private key should be securely stored and managed, and it should never be exposed
 * or transmitted in an unsecured manner.
 * @param privateKey The private key used for generating the public key.
 * @returns The derived public key.
 */
export function derivePublicKey(privateKey: BigNumberish): Point<string> {
    const s = deriveSecretScalar(privateKey)

    const publicKey = mulPointEscalar(Base8, BigInt(s))

    // Convert the public key values to strings so that it can easily be exported as a JSON.
    return [publicKey[0].toString(), publicKey[1].toString()]
}

/**
 * Signs a message using the provided private key, employing Poseidon hashing and
 * EdDSA with the Baby Jubjub elliptic curve.
 * @param privateKey The private key used to sign the message.
 * @param message The message to be signed.
 * @returns The signature object, containing properties relevant to EdDSA signatures, such as 'R8' and 'S' values.
 */
export function signMessage(privateKey: BigNumberish, message: BigNumberish): Signature<string> {
    // Convert the private key to buffer.
    privateKey = utils.checkPrivateKey(privateKey)

    // Convert the message to big integer.
    message = utils.checkMessage(message)

    const hash = blake(privateKey)

    const sBuff = utils.pruneBuffer(hash.slice(0, 32))
    const s = leBufferToBigInt(sBuff)
    const A = mulPointEscalar(Base8, scalar.shiftRight(s, BigInt(3)))

    const msgBuff = leBigIntToBuffer(message, 32)

    const rBuff = blake(Buffer.concat([hash.slice(32, 64), msgBuff]))

    const Fr = new F1Field(subOrder)
    const r = Fr.e(leBufferToBigInt(rBuff))

    const R8 = mulPointEscalar(Base8, r)
    const hm = poseidon5([R8[0], R8[1], A[0], A[1], message])
    const S = Fr.add(r, Fr.mul(hm, s))

    // Convert the signature values to strings so that it can easily be exported as a JSON.
    return {
        R8: [R8[0].toString(), R8[1].toString()],
        S: S.toString()
    }
}

/**
 * Verifies an EdDSA signature using the Baby Jubjub elliptic curve and Poseidon hash function.
 * @param message The original message that was be signed.
 * @param signature The EdDSA signature to be verified.
 * @param publicKey The public key associated with the private key used to sign the message.
 * @returns Returns true if the signature is valid and corresponds to the message and public key, false otherwise.
 */
export function verifySignature(message: BigNumberish, signature: Signature, publicKey: Point): boolean {
    if (
        !utils.isPoint(publicKey) ||
        !utils.isSignature(signature) ||
        !inCurve(signature.R8) ||
        !inCurve(publicKey) ||
        BigInt(signature.S) >= subOrder
    ) {
        return false
    }

    // Convert the message to big integer.
    message = utils.checkMessage(message)

    // Convert the signature values to big integers for calculations.
    const _signature: Signature<bigint> = {
        R8: [BigInt(signature.R8[0]), BigInt(signature.R8[1])],
        S: BigInt(signature.S)
    }
    // Convert the public key values to big integers for calculations.
    const _publicKey: Point<bigint> = [BigInt(publicKey[0]), BigInt(publicKey[1])]

    const hm = poseidon5([signature.R8[0], signature.R8[1], publicKey[0], publicKey[1], message])

    const pLeft = mulPointEscalar(Base8, BigInt(signature.S))
    let pRight = mulPointEscalar(_publicKey, scalar.mul(hm, BigInt(8)))

    pRight = addPoint(_signature.R8, pRight)

    // Return true if the points match.
    return Fr.eq(BigInt(pLeft[0]), pRight[0]) && Fr.eq(pLeft[1], pRight[1])
}

/**
 * Converts a given public key into a packed (compressed) string format for efficient transmission and storage.
 * This method ensures the public key is valid and within the Baby Jubjub curve before packing.
 * @param publicKey The public key to be packed.
 * @returns A string representation of the packed public key.
 */
export function packPublicKey(publicKey: Point): string {
    if (!utils.isPoint(publicKey) || !inCurve(publicKey)) {
        throw new Error("Invalid public key")
    }

    // Convert the public key values to big integers for calculations.
    const _publicKey: Point<bigint> = [BigInt(publicKey[0]), BigInt(publicKey[1])]

    return packPoint(_publicKey).toString()
}

/**
 * Unpacks a public key from its packed string representation back to its original point form on the Baby Jubjub curve.
 * This function checks for the validity of the input format before attempting to unpack.
 * @param publicKey The packed public key as a string or bigint.
 * @returns The unpacked public key as a point.
 */
export function unpackPublicKey(publicKey: BigNumber): Point<string> {
    if (
        typeof publicKey !== "bigint" &&
        (typeof publicKey !== "string" || !isStringifiedBigint(publicKey)) &&
        (typeof publicKey !== "string" || !isHexadecimal(publicKey))
    ) {
        throw new TypeError("Invalid public key type")
    }

    const unpackedPublicKey = unpackPoint(BigInt(publicKey))

    if (unpackedPublicKey === null) {
        throw new Error("Invalid public key")
    }

    return [unpackedPublicKey[0].toString(), unpackedPublicKey[1].toString()]
}

/**
 * Represents a cryptographic entity capable of signing messages and verifying signatures
 * using the EdDSA scheme with Poseidon hash and the Baby Jubjub elliptic curve.
 */
export class EdDSAPoseidon {
    // Private key for signing, stored securely.
    privateKey: BigNumberish
    // The secret scalar derived from the private key to compute the public key.
    secretScalar: string
    // The public key corresponding to the private key.
    publicKey: Point
    // A packed (compressed) representation of the public key for efficient operations.
    packedPublicKey: string

    /**
     * Initializes a new instance, deriving necessary cryptographic parameters from the provided private key.
     * @param privateKey The private key used for signing and public key derivation.
     */
    constructor(privateKey: BigNumberish) {
        this.privateKey = privateKey
        this.secretScalar = deriveSecretScalar(privateKey)
        this.publicKey = derivePublicKey(privateKey)
        this.packedPublicKey = packPublicKey(this.publicKey) as string
    }

    /**
     * Signs a given message using the private key and returns the signature.
     * @param message The message to be signed.
     * @returns The signature of the message.
     */
    signMessage(message: BigNumberish): Signature<string> {
        return signMessage(this.privateKey, message)
    }

    /**
     * Verifies a signature against a message and the public key stored in this instance.
     * @param message The message whose signature is to be verified.
     * @param signature The signature to be verified.
     * @returns True if the signature is valid for the message and public key, false otherwise.
     */
    verifySignature(message: BigNumberish, signature: Signature): boolean {
        return verifySignature(message, signature, this.publicKey)
    }
}
