using Asp.Versioning;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MindReader.Cloud.Application.Common.Interfaces;

namespace MindReader.Cloud.API.Controllers;

[ApiVersion("1.0")]
public class AuthController : ApiControllerBase
{
    private readonly IAuthService _authService;

    public AuthController(IAuthService authService)
    {
        _authService = authService;
    }

    [HttpPost("register")]
    [AllowAnonymous]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request)
    {
        var result = await _authService.RegisterAsync(request.Email, request.Password, request.Name);
        if (!result.IsSuccess) return BadRequest(new ProblemDetails { Status = 400, Detail = result.Error });
        return Ok(new { result.Token, result.RefreshToken, result.User });
    }

    [HttpPost("login")]
    [AllowAnonymous]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        var result = await _authService.LoginAsync(request.Email, request.Password);
        if (!result.IsSuccess) return Unauthorized(new ProblemDetails { Status = 401, Detail = result.Error });
        return Ok(new { result.Token, result.RefreshToken, result.User });
    }

    [HttpPost("refresh")]
    [AllowAnonymous]
    public async Task<IActionResult> Refresh([FromBody] RefreshRequest request)
    {
        var result = await _authService.RefreshTokenAsync(request.RefreshToken);
        if (!result.IsSuccess) return Unauthorized(new ProblemDetails { Status = 401, Detail = result.Error });
        return Ok(new { result.Token, result.RefreshToken, result.User });
    }

    [HttpPost("google")]
    [AllowAnonymous]
    public async Task<IActionResult> GoogleLogin([FromBody] GoogleLoginRequest request)
    {
        var result = await _authService.GoogleLoginAsync(request.IdToken);
        if (!result.IsSuccess) return BadRequest(new ProblemDetails { Status = 400, Detail = result.Error });
        return Ok(new { result.Token, result.RefreshToken, result.User });
    }

    [HttpPost("github")]
    [AllowAnonymous]
    public async Task<IActionResult> GitHubLogin([FromBody] GitHubLoginRequest request)
    {
        var result = await _authService.GitHubLoginAsync(request.Code);
        if (!result.IsSuccess) return BadRequest(new ProblemDetails { Status = 400, Detail = result.Error });
        return Ok(new { result.Token, result.RefreshToken, result.User });
    }

    [HttpGet("me")]
    [Authorize]
    public IActionResult Me([FromServices] ITenantService tenantService)
    {
        return Ok(new
        {
            UserId = tenantService.CurrentUserId,
            TenantId = tenantService.CurrentTenantId,
            Tier = tenantService.CurrentTier
        });
    }
}

public record RegisterRequest(string Email, string Password, string Name);
public record LoginRequest(string Email, string Password);
public record RefreshRequest(string RefreshToken);
public record GoogleLoginRequest(string IdToken);
public record GitHubLoginRequest(string Code);
